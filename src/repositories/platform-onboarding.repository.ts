/**
 * @file Staff-only, cross-tenant onboarding reads. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule);
 * every query leaves out the platform tenant. Progress is derived here, in
 * one SQL shape (`progressQuery`) shared by the funnel, the list, the
 * Overview's stuck count and the tenant tab, from the registry keys the
 * service passes in: a tenant step counts from its tenant row, a member
 * step once any active owner has done it, and a completion whose key left
 * the registry counts for nothing. Raw rows carry timestamps as UTC text
 * (drizzle's postgres-js driver hands timestamps back unparsed), which the
 * mappers turn into Dates.
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { OnboardingSource, OnboardingState } from '@/constants/onboarding.constants'
import type { PageDirection } from '@/constants/platform.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import { auditLogModel } from '@/database/models/audit-log.model'
import { onboardingCompletionModel } from '@/database/models/onboarding-completion.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * The registry, as the keys the progress query needs.
 */
export interface OnboardingRegistryKeys {
  tenantKeys: readonly string[]
  memberKeys: readonly string[]
  requiredKeys: readonly string[]
}

/**
 * What the derived state depends on besides the rows: the registry and the
 * instant at or before which a tenant's last progress makes it stuck.
 */
export interface OnboardingProgressOptions {
  keys: OnboardingRegistryKeys
  stuckBefore: Date
}

/**
 * One tenant's derived onboarding progress. `doneKeys` are the registry
 * steps done at tenant level; `lastProgressAt` is the latest of `startedAt`
 * and their completions; `completedAt` is set once every required step is
 * done.
 */
export interface OnboardingProgressRow {
  id: string
  name: string
  slug: string
  lifecycleState: TenantLifecycleState
  isTracked: boolean
  startedAt: Date | null
  dismissedAt: Date | null
  dismissedBy: string | null
  state: OnboardingState
  requiredDone: number
  doneKeys: string[]
  lastProgressAt: Date | null
  completedAt: Date | null
}

/**
 * A list row's sort key: its sort timestamp as UTC text with microseconds,
 * and its id.
 */
export interface OnboardingPageCursor {
  sortAt: string
  id: string
}

/**
 * A page of progress rows in display order, and the cursors either side of
 * it, each only when rows lie that way.
 */
export interface OnboardingProgressPage {
  rows: OnboardingProgressRow[]
  nextCursor?: OnboardingPageCursor
  prevCursor?: OnboardingPageCursor
}

/**
 * The list's inputs. `isAscending` is the display order: oldest progress
 * first for the stuck list, newest first otherwise.
 */
export interface OnboardingListOptions extends OnboardingProgressOptions {
  state: OnboardingState
  isAscending: boolean
  limit: number
  direction: PageDirection
  cursor?: OnboardingPageCursor | undefined
}

/**
 * A user as an onboarding read names them.
 */
export interface OnboardingUserRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * One active owner of a tenant.
 */
export interface OnboardingOwnerRow extends OnboardingUserRow {
  tenantId: string
}

/**
 * One live member of a tenant.
 */
export interface OnboardingMemberRow extends OnboardingUserRow {
  role: MembershipRole
  isActive: boolean
}

/**
 * One stored completion with the user who completed it, when there was one
 * and they still exist.
 */
export interface OnboardingCompletionRow {
  stepKey: string
  userId: string | null
  source: OnboardingSource
  reason: string | null
  completedAt: Date
  completedBy: OnboardingUserRow | null
}

/**
 * One `onboarding.reminder_sent` audit entry and its actor, null once redacted or purged.
 */
export interface OnboardingReminderRow {
  id: string
  occurredAt: Date
  metadata: Record<string, unknown>
  actor: OnboardingUserRow | null
}

/**
 * Per-state tenant counts and per-step completion counts for the funnel.
 */
export interface OnboardingFunnelCounts {
  states: { state: OnboardingState; count: number }[]
  steps: { stepKey: string; completed: number; staffCompleted: number }[]
}

/**
 * What the reconcile reads about one tracked, started tenant: when each
 * automatic trigger provably first happened, or null when nothing on file
 * proves it.
 */
export interface OnboardingReconcileRow {
  tenantId: string
  startedAt: Date
  /**
   * The earliest `tenant.settings_updated` entry with member access, at or after the start.
   */
  settingsUpdatedAt: Date | null
  /**
   * The earliest `invitation.created` entry with member access, at or after the start.
   */
  teammateInvitedAt: Date | null
  /**
   * When the tenant's second member joined, whenever that was.
   */
  secondJoinAt: Date | null
}

/**
 * A progress row as `execute` returns it: timestamps as UTC text.
 */
interface RawProgressRow extends Record<string, unknown> {
  id: string
  name: string
  slug: string
  lifecycle_state: TenantLifecycleState
  onboarding_tracked: boolean
  started_at: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  state: OnboardingState
  required_done: number
  done_keys: string[]
  last_progress_at: string | null
  completed_at: string | null
  sort_at: string
}

/**
 * A timestamp expression as UTC text with milliseconds, which `new Date` reads exactly.
 * @param expression - A `timestamptz` expression.
 * @returns The text expression.
 */
function isoText(expression: SQL): SQL {
  return sql`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
}

/**
 * A timestamp expression as UTC text with microseconds, the cursor's sort key.
 * @param expression - A `timestamptz` expression.
 * @returns The text expression.
 */
function sortText(expression: SQL): SQL {
  return sql`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * `column in (keys)`, or `false` for no keys (a registry with no member steps).
 * @param column - The key column, as raw SQL.
 * @param keys - The keys.
 * @returns The condition.
 */
function keyIn(column: SQL, keys: readonly string[]): SQL {
  return inArray(column, [...keys])
}

/**
 * Text from SQL as a Date.
 * @param text - UTC text from `isoText`, or null.
 * @returns The Date, or null.
 */
function dateOf(text: string | null): Date | null {
  // eslint-disable-next-line unicorn/no-null -- the column is nullable
  return text === null ? null : new Date(text)
}

/**
 * A raw progress row in its typed shape.
 * @param row - The row as `execute` returned it.
 * @returns The typed row.
 */
function toProgressRow(row: RawProgressRow): OnboardingProgressRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    lifecycleState: row.lifecycle_state,
    isTracked: row.onboarding_tracked,
    startedAt: dateOf(row.started_at),
    dismissedAt: dateOf(row.dismissed_at),
    dismissedBy: row.dismissed_by,
    state: row.state,
    requiredDone: row.required_done,
    doneKeys: row.done_keys,
    lastProgressAt: dateOf(row.last_progress_at),
    completedAt: dateOf(row.completed_at),
  }
}

/**
 * The common table expressions every progress read starts with, ending in
 * `progress` (one row per tenant `scope` selects) and `steps` (one row per
 * tenant and step done at tenant level, with whether staff completed it).
 * `scope` is a condition on `tenants t`; the platform tenant is always left
 * out. The rules are `deriveOnboardingState`'s (onboarding.service.ts):
 * last progress is the latest of the start and the counted completions; a
 * tenant is complete once started with every required step done, at the
 * latest of the start and those steps' completions; and stuck once its last
 * progress is at or before `stuckBefore`.
 * @param scope - Which tenants to read.
 * @param options - The registry keys and the stuck cut-off.
 * @returns The `with …` clause.
 */
function progressQuery(scope: SQL, options: OnboardingProgressOptions): SQL {
  const { tenantKeys, memberKeys, requiredKeys } = options.keys
  const requiredTotal = requiredKeys.length
  const stuckBefore = options.stuckBefore.toISOString()
  return sql`
    with scoped as (
      select t.id, t.name, t.slug, t.lifecycle_state, t.created_at, t.onboarding_tracked,
        t.onboarding_started_at, t.onboarding_dismissed_at, t.onboarding_dismissed_by
      from tenants t
      where not t.is_platform and ${scope}
    ),
    owners as (
      select m.tenant_id, m.user_id
      from user_memberships m
      join users u on u.id = m.user_id
      where m.role = 'owner' and u.deleted_at is null and u.active
        and m.tenant_id in (select id from scoped)
    ),
    counted as (
      select c.tenant_id, c.step_key, c.source, c.completed_at
      from onboarding_completions c
      where c.user_id is null and ${keyIn(sql.raw('c.step_key'), tenantKeys)}
        and c.tenant_id in (select id from scoped)
      union all
      select c.tenant_id, c.step_key, c.source, c.completed_at
      from onboarding_completions c
      join owners o on o.tenant_id = c.tenant_id and o.user_id = c.user_id
      where ${keyIn(sql.raw('c.step_key'), memberKeys)}
    ),
    steps as (
      select tenant_id, step_key::text as step_key, min(completed_at) as completed_at,
        bool_or(source = 'staff') as has_staff
      from counted
      group by tenant_id, step_key
    ),
    agg as (
      select tenant_id,
        (count(*) filter (where ${keyIn(sql.raw('step_key'), requiredKeys)}))::int as required_done,
        max(completed_at) filter (where ${keyIn(sql.raw('step_key'), requiredKeys)}) as last_required_at,
        max(completed_at) as last_completion_at,
        array_agg(step_key order by step_key) as done_keys
      from steps
      group by tenant_id
    ),
    progress as (
      select s.id, s.name, s.slug, s.lifecycle_state, s.created_at, s.onboarding_tracked,
        s.onboarding_started_at, s.onboarding_dismissed_at, s.onboarding_dismissed_by,
        coalesce(a.required_done, 0) as required_done,
        coalesce(a.done_keys, array[]::text[]) as done_keys,
        greatest(a.last_completion_at, s.onboarding_started_at) as last_progress_at,
        case when s.onboarding_started_at is not null and coalesce(a.required_done, 0) >= ${requiredTotal}
          then greatest(a.last_required_at, s.onboarding_started_at) end as completed_at,
        case
          when not s.onboarding_tracked then 'not_tracked'
          when s.onboarding_started_at is null then 'awaiting_owner'
          when coalesce(a.required_done, 0) >= ${requiredTotal} then 'complete'
          when s.onboarding_dismissed_at is not null then 'dismissed'
          when greatest(a.last_completion_at, s.onboarding_started_at) <= ${stuckBefore}::timestamptz
            then 'stuck'
          else 'in_progress'
        end as state
      from scoped s
      left join agg a on a.tenant_id = s.id
    )
  `
}

/**
 * The columns a progress row is read with, `sortAt` the given expression.
 * @param sortAt - The row's sort timestamp.
 * @returns The select list.
 */
function progressColumns(sortAt: SQL): SQL {
  return sql`
    p.id, p.name, p.slug, p.lifecycle_state, p.onboarding_tracked,
    ${isoText(sql.raw('p.onboarding_started_at'))} as started_at,
    ${isoText(sql.raw('p.onboarding_dismissed_at'))} as dismissed_at,
    p.onboarding_dismissed_by as dismissed_by,
    p.state, p.required_done, p.done_keys,
    ${isoText(sql.raw('p.last_progress_at'))} as last_progress_at,
    ${isoText(sql.raw('p.completed_at'))} as completed_at,
    ${sortText(sortAt)} as sort_at
  `
}

/**
 * The active, live, tracked customer tenants: what the funnel, the list and the stuck count cover.
 */
const ACTIVE_TRACKED = sql.raw(
  `t.lifecycle_state = 'active' and t.deleted_at is null and t.onboarding_tracked`
)

/**
 * The cursors either side of a page already in display order. A page read
 * from a cursor that comes back empty hands that cursor back on the side
 * it came from, so the client can always step back.
 * @param rows - The page's raw rows, in display order.
 * @param hasMore - Whether a row beyond the page exists in the read direction.
 * @param direction - Which way the page was read.
 * @param cursor - The cursor it was read from, if any.
 * @returns The cursors to set.
 */
function pageCursors(
  rows: readonly RawProgressRow[],
  hasMore: boolean,
  direction: PageDirection,
  cursor: OnboardingPageCursor | undefined
): Pick<OnboardingProgressPage, 'nextCursor' | 'prevCursor'> {
  const keyOf = (row: RawProgressRow): OnboardingPageCursor => ({ sortAt: row.sort_at, id: row.id })
  const first = rows.at(0)
  const last = rows.at(-1)
  if (direction === 'prev') {
    const next = last ? keyOf(last) : cursor
    return {
      ...(hasMore && first && { prevCursor: keyOf(first) }),
      ...(next && { nextCursor: next }),
    }
  }
  const previous = first ? keyOf(first) : cursor
  return {
    ...(hasMore && last && { nextCursor: keyOf(last) }),
    ...(cursor !== undefined && previous && { prevCursor: previous }),
  }
}

/**
 * Query access for staff onboarding reads.
 */
export class PlatformOnboardingRepository {
  /**
   * Per-state counts and per-step counts over the active, tracked tenants
   * whose onboarding started in `[from, to]`.
   * @param from - Inclusive start.
   * @param to - Inclusive end, the moment of the read.
   * @param options - The registry keys and the stuck cut-off.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The counts; states and steps with none are absent.
   */
  async funnelCounts(
    from: Date,
    to: Date,
    options: OnboardingProgressOptions,
    executor: DbExecutor = db
  ): Promise<OnboardingFunnelCounts> {
    const scope = sql`${ACTIVE_TRACKED} and t.onboarding_started_at >= ${from.toISOString()}::timestamptz
      and t.onboarding_started_at <= ${to.toISOString()}::timestamptz`
    const states = await executor.execute<{ state: OnboardingState; count: number }>(
      sql`${progressQuery(scope, options)}
        select state, count(*)::int as count from progress group by state`
    )
    const steps = await executor.execute<{
      step_key: string
      completed: number
      staff_completed: number
    }>(
      sql`${progressQuery(scope, options)}
        select step_key, count(*)::int as completed,
          (count(*) filter (where has_staff))::int as staff_completed
        from steps group by step_key`
    )
    return {
      states: [...states],
      steps: steps.map((row) => ({
        stepKey: row.step_key,
        completed: row.completed,
        staffCompleted: row.staff_completed,
      })),
    }
  }

  /**
   * How many active, tracked tenants there are, started or still awaiting
   * their first owner, whatever the range.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async countTracked(executor: DbExecutor = db): Promise<number> {
    const rows = await executor.execute<{ count: number }>(
      sql`select count(*)::int as count from tenants t where not t.is_platform and ${ACTIVE_TRACKED}`
    )
    return rows[0]?.count ?? 0
  }

  /**
   * How many active, tracked tenants are stuck.
   * @param options - The registry keys and the stuck cut-off.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async countStuck(options: OnboardingProgressOptions, executor: DbExecutor = db): Promise<number> {
    const rows = await executor.execute<{ count: number }>(
      sql`${progressQuery(ACTIVE_TRACKED, options)}
        select count(*)::int as count from progress where state = 'stuck'`
    )
    return rows[0]?.count ?? 0
  }

  /**
   * A keyset page of the active, tracked tenants in one state, sorted on
   * `(sort timestamp, id)`: the last progress for `stuck` (oldest first, so
   * the longest stuck lead), otherwise when onboarding started, or the
   * tenant was created while it awaits an owner (newest first).
   * `direction: 'prev'` reads the rows before `cursor` and returns them in
   * display order.
   * @param options - State, order, page size, direction, cursor, registry keys and stuck cut-off.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page, with `nextCursor`/`prevCursor` only when rows remain that way.
   */
  async listByState(
    options: OnboardingListOptions,
    executor: DbExecutor = db
  ): Promise<OnboardingProgressPage> {
    const isPrevious = options.direction === 'prev'
    const isReadAscending = options.isAscending !== isPrevious
    const sortExpression =
      options.state === 'stuck'
        ? sql.raw('p.last_progress_at')
        : sql.raw('coalesce(p.onboarding_started_at, p.created_at)')
    const comparison = isReadAscending ? sql.raw('>') : sql.raw('<')
    const order = isReadAscending ? sql.raw('asc') : sql.raw('desc')
    const afterCursor =
      options.cursor === undefined
        ? sql``
        : sql`and (${sortExpression}, p.id) ${comparison} (${options.cursor.sortAt}::timestamptz, ${options.cursor.id})`
    const rows = [
      ...(await executor.execute<RawProgressRow>(
        sql`${progressQuery(ACTIVE_TRACKED, options)}
          select ${progressColumns(sortExpression)}
          from progress p
          where p.state = ${options.state} ${afterCursor}
          order by ${sortExpression} ${order}, p.id ${order}
          limit ${options.limit + 1}`
      )),
    ]
    const hasMore = rows.length > options.limit
    if (hasMore) rows.pop()
    if (isPrevious) rows.reverse()
    return {
      rows: rows.map((row) => toProgressRow(row)),
      ...pageCursors(rows, hasMore, options.direction, options.cursor),
    }
  }

  /**
   * One customer tenant's progress, in any lifecycle state, soft-deleted included.
   * @param tenantId - The tenant.
   * @param options - The registry keys and the stuck cut-off.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when there is no such customer tenant.
   */
  async findProgress(
    tenantId: string,
    options: OnboardingProgressOptions,
    executor: DbExecutor = db
  ): Promise<OnboardingProgressRow | undefined> {
    const scope = sql`t.id = ${tenantId}`
    const [row] = await executor.execute<RawProgressRow>(
      sql`${progressQuery(scope, options)}
        select ${progressColumns(sql.raw('p.created_at'))} from progress p`
    )
    return row === undefined ? undefined : toProgressRow(row)
  }

  /**
   * The active owners (live, active users) of each tenant, by address.
   * @param tenantIds - The tenants.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The owners, ordered by tenant and lowercased address.
   */
  async activeOwners(
    tenantIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<OnboardingOwnerRow[]> {
    if (tenantIds.length === 0) return []
    return executor
      .select({
        tenantId: userMembershipModel.tenantId,
        id: userModel.id,
        email: userModel.email,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
      })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(
        and(
          inArray(userMembershipModel.tenantId, [...tenantIds]),
          eq(userMembershipModel.role, 'owner'),
          isNull(userModel.deletedAt),
          eq(userModel.active, true)
        )
      )
      .orderBy(userMembershipModel.tenantId, sql`lower(${userModel.email})`)
  }

  /**
   * A tenant's live members, each with whether they can still sign in.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The members, ordered by lowercased address.
   */
  async listMembers(tenantId: string, executor: DbExecutor = db): Promise<OnboardingMemberRow[]> {
    return executor
      .select({
        id: userModel.id,
        email: userModel.email,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
        role: userMembershipModel.role,
        isActive: userModel.active,
      })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(and(eq(userMembershipModel.tenantId, tenantId), isNull(userModel.deletedAt)))
      .orderBy(sql`lower(${userModel.email})`)
  }

  /**
   * Every stored completion of a tenant, oldest first, with the user who
   * completed it when they still exist. Keys that left the registry are
   * returned too; the service ignores them.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The completions.
   */
  async listCompletions(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<OnboardingCompletionRow[]> {
    const rows = await executor
      .select({
        stepKey: onboardingCompletionModel.stepKey,
        userId: onboardingCompletionModel.userId,
        source: onboardingCompletionModel.source,
        reason: onboardingCompletionModel.reason,
        completedAt: onboardingCompletionModel.completedAt,
        completedById: userModel.id,
        completedByEmail: userModel.email,
        completedByFirstName: userModel.firstName,
        completedByLastName: userModel.lastName,
      })
      .from(onboardingCompletionModel)
      .leftJoin(userModel, eq(userModel.id, onboardingCompletionModel.completedBy))
      .where(eq(onboardingCompletionModel.tenantId, tenantId))
      .orderBy(asc(onboardingCompletionModel.completedAt), asc(onboardingCompletionModel.id))
    return rows.map((row) => ({
      stepKey: row.stepKey,
      userId: row.userId,
      source: row.source,
      reason: row.reason,
      completedAt: row.completedAt,
      completedBy:
        row.completedById === null || row.completedByEmail === null
          ? // eslint-disable-next-line unicorn/no-null -- no actor, or a purged one
            null
          : {
              id: row.completedById,
              email: row.completedByEmail,
              firstName: row.completedByFirstName,
              lastName: row.completedByLastName,
            },
    }))
  }

  /**
   * Users by id, for names an onboarding read shows (who dismissed it).
   * @param userIds - The ids.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The users found, by id; a purged one is absent.
   */
  async usersById(
    userIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, OnboardingUserRow>> {
    if (userIds.length === 0) return new Map()
    const rows = await executor
      .select({
        id: userModel.id,
        email: userModel.email,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
      })
      .from(userModel)
      .where(inArray(userModel.id, [...userIds]))
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * A tenant's `onboarding.reminder_sent` entries, newest first.
   * @param tenantId - The tenant.
   * @param limit - How many to return.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The entries.
   */
  async listReminders(
    tenantId: string,
    limit: number,
    executor: DbExecutor = db
  ): Promise<OnboardingReminderRow[]> {
    const rows = await executor
      .select({
        id: auditLogModel.id,
        occurredAt: auditLogModel.occurredAt,
        metadata: auditLogModel.metadata,
        actorId: userModel.id,
        actorEmail: userModel.email,
        actorFirstName: userModel.firstName,
        actorLastName: userModel.lastName,
      })
      .from(auditLogModel)
      .leftJoin(userModel, eq(userModel.id, auditLogModel.actorUserId))
      .where(
        and(
          eq(auditLogModel.tenantId, tenantId),
          eq(auditLogModel.action, 'onboarding.reminder_sent')
        )
      )
      .orderBy(desc(auditLogModel.occurredAt), desc(auditLogModel.id))
      .limit(limit)
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      metadata: row.metadata,
      actor:
        row.actorId === null || row.actorEmail === null
          ? // eslint-disable-next-line unicorn/no-null -- redacted, or the actor was purged
            null
          : {
              id: row.actorId,
              email: row.actorEmail,
              firstName: row.actorFirstName,
              lastName: row.actorLastName,
            },
    }))
  }

  /**
   * When the tenant's latest reminder was sent: the 24-hour limit reads it.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The time, or undefined when none was ever sent.
   */
  async latestReminderAt(tenantId: string, executor: DbExecutor = db): Promise<Date | undefined> {
    const [row] = await executor
      .select({ occurredAt: auditLogModel.occurredAt })
      .from(auditLogModel)
      .where(
        and(
          eq(auditLogModel.tenantId, tenantId),
          eq(auditLogModel.action, 'onboarding.reminder_sent')
        )
      )
      .orderBy(desc(auditLogModel.occurredAt), desc(auditLogModel.id))
      .limit(1)
    return row?.occurredAt
  }

  /**
   * What the reconcile re-derives from, for every live, tracked, started
   * customer tenant, read only from records of what members did: the
   * earliest member-access `tenant.settings_updated` and `invitation.created`
   * audit entries at or after the clock's start (staff acting through
   * platform access record `access = 'platform'`, so they never count), and
   * when the second member joined. A join is dated by its
   * `invitation.accepted` entry (always member access; its target is the
   * membership) and, when retention has pruned that entry, by the
   * membership's `created_at`; a membership with neither is gone and cannot
   * be counted. Every membership but a tenant's first comes from an accept,
   * since members join by invitation only. Bounded by audit retention
   * (`RETENTION_AUDIT_LOGS_DAYS`; 0 keeps entries forever).
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per tenant.
   */
  async reconcileCandidates(executor: DbExecutor = db): Promise<OnboardingReconcileRow[]> {
    // Spelled out: drizzle renders a one-table select's columns unqualified, binding them inside.
    const earliestMemberEntry = (action: 'tenant.settings_updated' | 'invitation.created') =>
      sql<Date | null>`(
        select min(entry.occurred_at) from audit_logs entry
        where entry.tenant_id = "tenants"."id"
          and entry.action = ${action}
          and entry.access = 'member'
          and entry.occurred_at >= "tenants"."onboarding_started_at"
      )`.mapWith(auditLogModel.occurredAt)
    // One join time per membership: its accept entry's when on file (rank 0), else its row's.
    const secondJoinAt = sql<Date | null>`(
      select joins.joined_at from (
        select distinct on (dated.membership_id) dated.membership_id, dated.joined_at
        from (
          select membership.id as membership_id, membership.created_at as joined_at, 1 as rank
          from user_memberships membership
          where membership.tenant_id = "tenants"."id"
          union all
          select entry.target_id, entry.occurred_at, 0
          from audit_logs entry
          where entry.tenant_id = "tenants"."id"
            and entry.action = 'invitation.accepted'
            and entry.access = 'member'
            and entry.target_id is not null
        ) dated
        order by dated.membership_id, dated.rank
      ) joins
      order by joins.joined_at
      offset 1 limit 1
    )`.mapWith(userMembershipModel.createdAt)
    const rows = await executor
      .select({
        tenantId: tenantModel.id,
        startedAt: tenantModel.onboardingStartedAt,
        settingsUpdatedAt: earliestMemberEntry('tenant.settings_updated'),
        teammateInvitedAt: earliestMemberEntry('invitation.created'),
        secondJoinAt,
      })
      .from(tenantModel)
      .where(
        and(
          eq(tenantModel.isPlatform, false),
          isNull(tenantModel.deletedAt),
          eq(tenantModel.onboardingTracked, true),
          sql`${tenantModel.onboardingStartedAt} is not null`
        )
      )
    return rows.flatMap((row) => (row.startedAt ? [{ ...row, startedAt: row.startedAt }] : []))
  }
}
