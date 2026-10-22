/**
 * @file Staff-only, cross-tenant reads of the email tracking tables: the
 * message search and detail, the health aggregates, the suppression list,
 * and the batched lookups `canResend` needs. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule).
 * Lists go through `listPage`; the cursor carries `created_at` as UTC text with
 * microseconds and the id breaks a tie.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  BounceKind,
  EmailEventType,
  EmailMessageStatus,
  FailureOrigin,
  SenderClass,
  SuppressionReason,
} from '@/constants/email.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import { emailEventModel } from '@/database/models/email-event.model'
import { emailLogModel, type EmailLogStatus } from '@/database/models/email-log.model'
import { emailMessageModel } from '@/database/models/email-message.model'
import { emailSuppressionModel } from '@/database/models/email-suppression.model'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { pendingCondition } from '@/repositories/tenant-invitation.repository'
import { db, type DbExecutor } from '@/services/database.service'
import {
  defineList,
  listPage,
  searchCondition,
  textSort,
  timestampKey,
  timestampSort,
  type ListPage,
  type ListParams,
} from '@/utilities/list-page.utilities'

/**
 * The user a message or suppression names, as joined. `deletedAt` is set
 * for a soft-deleted user, who still has a detail page.
 */
export interface EmailUserRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  isActive: boolean
  isVerified: boolean
  deletedAt: Date | null
}

/**
 * One `email_messages` row with its user and tenant joined (each null when
 * the message has none or the row was purged). Never the stored variables.
 */
export interface PlatformEmailRecord {
  id: string
  recipient: string
  templateKey: string
  status: EmailMessageStatus
  senderClass: SenderClass
  linkApp: FrontendApp | null
  failureOrigin: FailureOrigin | null
  userId: string | null
  tenantId: string | null
  invitationId: string | null
  resentFromId: string | null
  createdAt: Date
  statusUpdatedAt: Date
  user: EmailUserRow | null
  tenant: { id: string; name: string; slug: string } | null
}

/**
 * The message list's filters: each asked status and template, the user and
 * tenant, `createdFrom` inclusive and `createdBefore` exclusive.
 */
export interface PlatformEmailFilters {
  statuses?: EmailMessageStatus[] | undefined
  templateKeys?: string[] | undefined
  userId?: string | undefined
  tenantId?: string | undefined
  createdFrom?: Date | undefined
  createdBefore?: Date | undefined
}

/**
 * The suppression list's filters: the asked states.
 */
export interface PlatformSuppressionFilters {
  states: ('active' | 'lifted')[]
}

/**
 * One send attempt of a message.
 */
export interface EmailAttemptRow {
  id: string
  status: EmailLogStatus
  errorCode: string | null
  createdAt: Date
}

/**
 * One provider event of a message.
 */
export interface EmailEventRow {
  id: string
  provider: string
  type: EmailEventType
  bounceKind: BounceKind | null
  detail: string | null
  occurredAt: Date
}

/**
 * An active suppression, as the message detail and `canResend` read it.
 */
export interface ActiveSuppressionRow {
  id: string
  address: string
  reason: SuppressionReason
  createdAt: Date
}

/**
 * An invitation as `canResend` reads it.
 */
export interface ResendInvitationRow {
  id: string
  tenantId: string
  role: MembershipRole
}

/**
 * One suppression with who lifted it and the message whose event caused it.
 */
export interface PlatformSuppressionRecord {
  id: string
  address: string
  reason: SuppressionReason
  sourceMessageId: string | null
  createdAt: Date
  liftedAt: Date | null
  liftReason: string | null
  liftedBy: EmailUserRow | null
}

/**
 * Messages created on one UTC day in one status.
 */
export interface EmailStatusDayRow {
  day: string
  status: EmailMessageStatus
  count: number
}

/**
 * Messages from the `general` sender that are neither `queued` nor
 * `suppressed`, and how many of them have an opened event and how many a
 * clicked event.
 */
export interface EmailEngagementCounts {
  sent: number
  opened: number
  clicked: number
}

/**
 * Per-key counts for the health tables, over the `LEFT_SERVER_STATUSES`
 * statuses (`queued` and `suppressed` excluded).
 */
export interface EmailBreakdownCounts {
  key: string
  messages: number
  undelivered: number
  complained: number
}

/**
 * The statuses the health counts include: everything but `queued` and
 * `suppressed`. A `failed` message counts even when it failed at enqueue and
 * so never reached a provider.
 */
const LEFT_SERVER_STATUSES: readonly EmailMessageStatus[] = [
  'sent',
  'deferred',
  'delivered',
  'bounced',
  'failed',
  'complained',
]

/**
 * The statuses the health tables count as undelivered.
 */
const UNDELIVERED_STATUSES: readonly EmailMessageStatus[] = ['bounced', 'failed']

/**
 * A timestamp's UTC day, as `YYYY-MM-DD`.
 * @param column - A `timestamptz` column.
 * @returns The day as text.
 */
function utcDay(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`
}

/**
 * A row without its sort key.
 * @param row - A selected row.
 * @param row.sortAt - Its sort key, dropped.
 * @returns The row, `sortAt` dropped.
 */
function withoutSortKey<TRow extends { sortAt: string }>({
  sortAt: _sortAt,
  ...row
}: TRow): Omit<TRow, 'sortAt'> {
  return row
}

/**
 * A left-joined user, or null when the join found none.
 * @param row - The joined columns, all null when no user matched.
 * @param row.id - The user's id.
 * @param row.email - Their address.
 * @param row.firstName - Their first name.
 * @param row.lastName - Their last name.
 * @param row.isActive - Whether the account is active.
 * @param row.isVerified - Whether they have verified their address.
 * @param row.deletedAt - When they were soft-deleted.
 * @returns The user, or null.
 */
function userOrNull(row: {
  id: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  isActive: boolean | null
  isVerified: boolean
  deletedAt: Date | null
}): EmailUserRow | null {
  if (row.id === null || row.email === null) {
    // oxlint-disable-next-line unicorn/no-null -- no user row joined: purged, or the message had none
    return null
  }
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    isActive: row.isActive ?? true,
    isVerified: row.isVerified,
    deletedAt: row.deletedAt,
  }
}

/**
 * The columns a message query selects: the message without its stored
 * variables, the user and tenant join columns, and the cursor's sort key.
 */
const messageColumns = {
  id: emailMessageModel.id,
  recipient: emailMessageModel.recipient,
  templateKey: emailMessageModel.templateKey,
  status: emailMessageModel.status,
  senderClass: emailMessageModel.senderClass,
  linkApp: emailMessageModel.linkApp,
  failureOrigin: emailMessageModel.failureOrigin,
  userId: emailMessageModel.userId,
  tenantId: emailMessageModel.tenantId,
  invitationId: emailMessageModel.invitationId,
  resentFromId: emailMessageModel.resentFromId,
  createdAt: emailMessageModel.createdAt,
  statusUpdatedAt: emailMessageModel.statusUpdatedAt,
  sortAt: timestampKey(emailMessageModel.createdAt),
  joinedUserId: userModel.id,
  joinedUserEmail: userModel.email,
  joinedUserFirstName: userModel.firstName,
  joinedUserLastName: userModel.lastName,
  joinedUserActive: userModel.active,
  joinedUserVerifiedAt: userModel.emailVerifiedAt,
  joinedUserDeletedAt: userModel.deletedAt,
  joinedTenantId: tenantModel.id,
  joinedTenantName: tenantModel.name,
  joinedTenantSlug: tenantModel.slug,
}

/**
 * The message columns with the user and tenant left-joined, unfiltered.
 * @param executor - Where the query will run.
 * @returns The select, open for `where`, `orderBy` and `limit`.
 */
function selectMessages(executor: DbExecutor) {
  return executor
    .select(messageColumns)
    .from(emailMessageModel)
    .leftJoin(userModel, eq(userModel.id, emailMessageModel.userId))
    .leftJoin(tenantModel, eq(tenantModel.id, emailMessageModel.tenantId))
    .$dynamic()
}

/**
 * One selected message row, before the joins are folded into objects.
 */
type MessageSelection = Awaited<ReturnType<typeof selectMessages>>[number]

/**
 * Fold a selected message row's join columns into `user` and `tenant`.
 * @param row - The selected row.
 * @returns The record and its sort key.
 */
function toRecord(row: MessageSelection): PlatformEmailRecord & { sortAt: string } {
  const {
    joinedUserId,
    joinedUserEmail,
    joinedUserFirstName,
    joinedUserLastName,
    joinedUserActive,
    joinedUserVerifiedAt,
    joinedUserDeletedAt,
    joinedTenantId,
    joinedTenantName,
    joinedTenantSlug,
    ...message
  } = row
  return {
    ...message,
    user: userOrNull({
      id: joinedUserId,
      email: joinedUserEmail,
      firstName: joinedUserFirstName,
      lastName: joinedUserLastName,
      isActive: joinedUserActive,
      isVerified: joinedUserVerifiedAt !== null,
      deletedAt: joinedUserDeletedAt,
    }),
    tenant:
      joinedTenantId !== null && joinedTenantName !== null && joinedTenantSlug !== null
        ? { id: joinedTenantId, name: joinedTenantName, slug: joinedTenantSlug }
        : // oxlint-disable-next-line unicorn/no-null -- no tenant row joined: purged, or the message had none
          null,
  }
}

/**
 * The message list's conditions: search on the recipient, then the filters.
 * @param search - The parsed search, or undefined.
 * @param filters - The filters.
 * @returns The conditions to AND together.
 */
function messageConditions(
  search: string | undefined,
  filters: PlatformEmailFilters
): (SQL | undefined)[] {
  return [
    searchCondition(search, [sql`lower(${emailMessageModel.recipient})`]),
    filters.statuses === undefined
      ? undefined
      : inArray(emailMessageModel.status, filters.statuses),
    filters.templateKeys === undefined
      ? undefined
      : inArray(emailMessageModel.templateKey, filters.templateKeys),
    filters.tenantId === undefined ? undefined : eq(emailMessageModel.tenantId, filters.tenantId),
    filters.userId === undefined ? undefined : eq(emailMessageModel.userId, filters.userId),
    filters.createdFrom === undefined
      ? undefined
      : gte(emailMessageModel.createdAt, filters.createdFrom),
    filters.createdBefore === undefined
      ? undefined
      : lt(emailMessageModel.createdAt, filters.createdBefore),
  ]
}

/**
 * The staff message list, newest first by default.
 * @param search - The parsed search, or undefined.
 * @param filters - The filters.
 * @returns The list definition.
 */
export function platformEmailList(search: string | undefined, filters: PlatformEmailFilters) {
  return defineList({
    name: 'platform-emails',
    base: (executor, seek) =>
      selectMessages(executor).where(and(...messageConditions(search, filters), seek)),
    id: emailMessageModel.id,
    sorts: {
      '-created': [timestampSort(emailMessageModel.createdAt, 'desc', 'sortAt')],
      created: [timestampSort(emailMessageModel.createdAt, 'asc', 'sortAt')],
    },
    toItem: (row): PlatformEmailRecord => withoutSortKey(toRecord(row)),
  })
}

/**
 * The state filter: active (not lifted) or lifted, or nothing when both are asked for.
 * @param states - The asked states, at least one.
 * @returns The condition, or undefined for both.
 */
function suppressionStateCondition(states: PlatformSuppressionFilters['states']): SQL | undefined {
  if (states.length !== 1) return undefined
  return states[0] === 'active'
    ? isNull(emailSuppressionModel.liftedAt)
    : isNotNull(emailSuppressionModel.liftedAt)
}

/**
 * The staff suppression list, newest first by default.
 * @param search - The parsed search, or undefined.
 * @param filters - The states.
 * @returns The list definition.
 */
export function platformSuppressionList(
  search: string | undefined,
  filters: PlatformSuppressionFilters
) {
  const state = suppressionStateCondition(filters.states)
  return defineList({
    name: 'platform-email-suppressions',
    base: (executor, seek) =>
      selectSuppressions(executor).where(
        and(state, searchCondition(search, [sql`${emailSuppressionModel.address}`]), seek)
      ),
    id: emailSuppressionModel.id,
    sorts: {
      '-created': [timestampSort(emailSuppressionModel.createdAt, 'desc', 'sortAt')],
      created: [timestampSort(emailSuppressionModel.createdAt, 'asc', 'sortAt')],
      address: [textSort(emailSuppressionModel.address, 'asc', 'address')],
    },
    toItem: (row): PlatformSuppressionRecord => withoutSortKey(toSuppressionRecord(row)),
  })
}

/**
 * Messages created in `[from, to)` in a `LEFT_SERVER_STATUSES` status.
 * @param from - Inclusive start.
 * @param to - Exclusive end.
 * @returns The condition.
 */
function leftServerIn(from: Date, to: Date): SQL | undefined {
  return and(
    gte(emailMessageModel.createdAt, from),
    lt(emailMessageModel.createdAt, to),
    inArray(emailMessageModel.status, [...LEFT_SERVER_STATUSES])
  )
}

/**
 * Query access for the staff email pages.
 */
export class PlatformEmailRepository {
  /**
   * One page of the staff message list.
   * @param params - The parsed shared list params.
   * @param filters - The filters.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async list(
    params: ListParams,
    filters: PlatformEmailFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<PlatformEmailRecord>> {
    return listPage(executor, platformEmailList(params.search, filters), params)
  }

  /**
   * One message with its user and tenant.
   * @param id - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The record, or undefined when no message has that id.
   */
  async findRecord(
    id: string,
    executor: DbExecutor = db
  ): Promise<PlatformEmailRecord | undefined> {
    const [row] = await selectMessages(executor).where(eq(emailMessageModel.id, id)).limit(1)
    return row === undefined ? undefined : withoutSortKey(toRecord(row))
  }

  /**
   * The stored preview variables of one message: only the template's
   * non-secret `previewVariables` are ever written there.
   * @param id - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The variables, or undefined when no message has that id.
   */
  async findVariables(
    id: string,
    executor: DbExecutor = db
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await executor
      .select({ variables: emailMessageModel.variables })
      .from(emailMessageModel)
      .where(eq(emailMessageModel.id, id))
      .limit(1)
    return row?.variables
  }

  /**
   * A message's send attempts, oldest first.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The attempts.
   */
  async listAttempts(messageId: string, executor: DbExecutor = db): Promise<EmailAttemptRow[]> {
    return executor
      .select({
        id: emailLogModel.id,
        status: emailLogModel.status,
        errorCode: emailLogModel.errorCode,
        createdAt: emailLogModel.createdAt,
      })
      .from(emailLogModel)
      .where(eq(emailLogModel.messageId, messageId))
      .orderBy(asc(emailLogModel.createdAt), asc(emailLogModel.id))
  }

  /**
   * A message's provider events, in the order they occurred.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The events.
   */
  async listEvents(messageId: string, executor: DbExecutor = db): Promise<EmailEventRow[]> {
    return executor
      .select({
        id: emailEventModel.id,
        provider: emailEventModel.provider,
        type: emailEventModel.type,
        bounceKind: emailEventModel.bounceKind,
        detail: emailEventModel.detail,
        occurredAt: emailEventModel.occurredAt,
      })
      .from(emailEventModel)
      .where(eq(emailEventModel.messageId, messageId))
      .orderBy(asc(emailEventModel.occurredAt), asc(emailEventModel.id))
  }

  /**
   * The ids of the messages resent from this one, oldest first.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The ids.
   */
  async listResentAsIds(messageId: string, executor: DbExecutor = db): Promise<string[]> {
    const rows = await executor
      .select({ id: emailMessageModel.id })
      .from(emailMessageModel)
      .where(eq(emailMessageModel.resentFromId, messageId))
      .orderBy(asc(emailMessageModel.createdAt), asc(emailMessageModel.id))
    return rows.map((row) => row.id)
  }

  /**
   * The active suppressions among some addresses, matched case-insensitively.
   * @param addresses - The addresses, in any case.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per suppressed address, keyed by the lowercased address.
   */
  async activeSuppressionsFor(
    addresses: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, ActiveSuppressionRow>> {
    const lowered = [...new Set(addresses.map((address) => address.toLowerCase()))]
    if (lowered.length === 0) return new Map()
    const rows = await executor
      .select({
        id: emailSuppressionModel.id,
        address: emailSuppressionModel.address,
        reason: emailSuppressionModel.reason,
        createdAt: emailSuppressionModel.createdAt,
      })
      .from(emailSuppressionModel)
      .where(
        and(inArray(emailSuppressionModel.address, lowered), isNull(emailSuppressionModel.liftedAt))
      )
    return new Map(rows.map((row) => [row.address, row]))
  }

  /**
   * The platform roles of some users.
   * @param userIds - The users.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Each staff user's platform role; users without one are absent.
   */
  async platformRolesOf(
    userIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, MembershipRole>> {
    if (userIds.length === 0) return new Map()
    const rows = await executor
      .select({ userId: userMembershipModel.userId, role: userMembershipModel.role })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
      .where(
        and(eq(tenantModel.isPlatform, true), inArray(userMembershipModel.userId, [...userIds]))
      )
    return new Map(rows.map((row) => [row.userId, row.role]))
  }

  /**
   * One user's membership roles in some tenants.
   * @param userId - The user.
   * @param tenantIds - The tenants.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The role per tenant the user is a member of; other tenants are absent.
   */
  async membershipRolesIn(
    userId: string,
    tenantIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, MembershipRole>> {
    if (tenantIds.length === 0) return new Map()
    const rows = await executor
      .select({ tenantId: userMembershipModel.tenantId, role: userMembershipModel.role })
      .from(userMembershipModel)
      .where(
        and(
          eq(userMembershipModel.userId, userId),
          inArray(userMembershipModel.tenantId, [...tenantIds])
        )
      )
    return new Map(rows.map((row) => [row.tenantId, row.role]))
  }

  /**
   * Some invitations' tenants and roles, only those a resend can act on:
   * pending, as `findPendingById` defines it (neither accepted nor revoked;
   * an expired one is still pending, and a resend re-issues it).
   * @param invitationIds - The invitations.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Each pending invitation, keyed by id.
   */
  async pendingInvitationsById(
    invitationIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, ResendInvitationRow>> {
    if (invitationIds.length === 0) return new Map()
    const rows = await executor
      .select({
        id: tenantInvitationModel.id,
        tenantId: tenantInvitationModel.tenantId,
        role: tenantInvitationModel.role,
      })
      .from(tenantInvitationModel)
      .where(and(inArray(tenantInvitationModel.id, [...invitationIds]), pendingCondition()))
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * A tenant's lifecycle state and platform flag.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The state and flag, or undefined when the tenant is gone or soft-deleted.
   */
  async tenantState(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<{ lifecycleState: TenantLifecycleState; isPlatform: boolean } | undefined> {
    const [row] = await executor
      .select({ lifecycleState: tenantModel.lifecycleState, isPlatform: tenantModel.isPlatform })
      .from(tenantModel)
      .where(and(eq(tenantModel.id, tenantId), isNull(tenantModel.deletedAt)))
      .limit(1)
    return row
  }

  /**
   * Which of some tenants are active: lifecycle `active` and not soft-deleted,
   * the condition a resend's tenant gate applies.
   * @param tenantIds - The tenants.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The ids of the active ones.
   */
  async activeTenantIds(
    tenantIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set()
    const rows = await executor
      .select({ id: tenantModel.id })
      .from(tenantModel)
      .where(
        and(
          inArray(tenantModel.id, [...tenantIds]),
          eq(tenantModel.lifecycleState, 'active'),
          isNull(tenantModel.deletedAt)
        )
      )
    return new Set(rows.map((row) => row.id))
  }

  /**
   * Messages created per UTC day and status in `[from, to)`.
   * @param from - Inclusive start, a UTC midnight.
   * @param to - Exclusive end, a UTC midnight.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per day and status that has any.
   */
  async statusCountsByDay(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<EmailStatusDayRow[]> {
    const day = utcDay(emailMessageModel.createdAt)
    return executor
      .select({ day, status: emailMessageModel.status, count: count() })
      .from(emailMessageModel)
      .where(and(gte(emailMessageModel.createdAt, from), lt(emailMessageModel.createdAt, to)))
      .groupBy(day, emailMessageModel.status)
      .orderBy(day)
  }

  /**
   * Provider events received in `[from, to)`, whatever message they belong to.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async providerEventCount(from: Date, to: Date, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
      .select({ count: count() })
      .from(emailEventModel)
      .where(and(gte(emailEventModel.receivedAt, from), lt(emailEventModel.receivedAt, to)))
    return row?.count ?? 0
  }

  /**
   * Open and click counts over `general`-sender messages created in
   * `[from, to)` in a `LEFT_SERVER_STATUSES` status. Only the `general`
   * sender is counted: token emails go through the transactional sender,
   * whose click tracking is off, so they can record no click and are left
   * out of the sent, opened and clicked counts alike.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The denominator and both numerators.
   */
  async engagement(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<EmailEngagementCounts> {
    /**
     * Count the matched messages that have at least one event of `type`. The
     * subquery is a builder query, not raw SQL: drizzle leaves a single-table
     * query's own columns unqualified, which would bind this message id to the
     * event's.
     */
    const withEvent = (type: EmailEventType): SQL<number> => {
      const event = executor
        .select({ id: emailEventModel.id })
        .from(emailEventModel)
        .where(
          and(eq(emailEventModel.messageId, emailMessageModel.id), eq(emailEventModel.type, type))
        )
      return sql<number>`count(*) filter (where ${exists(event)})`.mapWith(Number)
    }
    const [row] = await executor
      .select({ sent: count(), opened: withEvent('opened'), clicked: withEvent('clicked') })
      .from(emailMessageModel)
      .where(and(leftServerIn(from, to), eq(emailMessageModel.senderClass, 'general')))
    return { sent: row?.sent ?? 0, opened: row?.opened ?? 0, clicked: row?.clicked ?? 0 }
  }

  /**
   * Messages created in `[from, to)` in a `LEFT_SERVER_STATUSES` status,
   * grouped by template or by lowercased recipient domain, most messages
   * first.
   * @param by - Group by `template` or `domain`.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param limit - The most groups returned.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per group.
   */
  async breakdown(
    by: 'template' | 'domain',
    from: Date,
    to: Date,
    limit: number,
    executor: DbExecutor = db
  ): Promise<EmailBreakdownCounts[]> {
    const key =
      by === 'template'
        ? sql<string>`${emailMessageModel.templateKey}`
        : sql<string>`lower(split_part(${emailMessageModel.recipient}, '@', 2))`
    const undelivered =
      sql<number>`count(*) filter (where ${inArray(emailMessageModel.status, [...UNDELIVERED_STATUSES])})`.mapWith(
        Number
      )
    const complained =
      sql<number>`count(*) filter (where ${eq(emailMessageModel.status, 'complained')})`.mapWith(
        Number
      )
    return executor
      .select({ key, messages: count(), undelivered, complained })
      .from(emailMessageModel)
      .where(leftServerIn(from, to))
      .groupBy(key)
      .orderBy(desc(count()), asc(key))
      .limit(limit)
  }

  /**
   * One page of the staff suppression list.
   * @param params - The parsed shared list params.
   * @param filters - The states.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listSuppressions(
    params: ListParams,
    filters: PlatformSuppressionFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<PlatformSuppressionRecord>> {
    return listPage(executor, platformSuppressionList(params.search, filters), params)
  }

  /**
   * One suppression, lifted or not.
   * @param id - The suppression id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The record, or undefined when no suppression has that id.
   */
  async findSuppression(
    id: string,
    executor: DbExecutor = db
  ): Promise<PlatformSuppressionRecord | undefined> {
    const [row] = await selectSuppressions(executor)
      .where(eq(emailSuppressionModel.id, id))
      .limit(1)
    return row === undefined ? undefined : withoutSortKey(toSuppressionRecord(row))
  }
}

/**
 * The suppression columns, with the lifter and the source event's message
 * left-joined, unfiltered.
 * @param executor - Where the query will run.
 * @returns The select, open for `where`, `orderBy` and `limit`.
 */
function selectSuppressions(executor: DbExecutor) {
  return executor
    .select({
      id: emailSuppressionModel.id,
      address: emailSuppressionModel.address,
      reason: emailSuppressionModel.reason,
      sourceMessageId: emailEventModel.messageId,
      createdAt: emailSuppressionModel.createdAt,
      liftedAt: emailSuppressionModel.liftedAt,
      liftReason: emailSuppressionModel.liftReason,
      sortAt: timestampKey(emailSuppressionModel.createdAt),
      lifterId: userModel.id,
      lifterEmail: userModel.email,
      lifterFirstName: userModel.firstName,
      lifterLastName: userModel.lastName,
      lifterActive: userModel.active,
      lifterVerifiedAt: userModel.emailVerifiedAt,
      lifterDeletedAt: userModel.deletedAt,
    })
    .from(emailSuppressionModel)
    .leftJoin(emailEventModel, eq(emailEventModel.id, emailSuppressionModel.sourceEventId))
    .leftJoin(userModel, eq(userModel.id, emailSuppressionModel.liftedBy))
    .$dynamic()
}

/**
 * Fold a selected suppression row's lifter columns into `liftedBy`.
 * @param row - The selected row.
 * @returns The record and its sort key.
 */
function toSuppressionRecord(
  row: Awaited<ReturnType<typeof selectSuppressions>>[number]
): PlatformSuppressionRecord & { sortAt: string } {
  const {
    lifterId,
    lifterEmail,
    lifterFirstName,
    lifterLastName,
    lifterActive,
    lifterVerifiedAt,
    lifterDeletedAt,
    ...rest
  } = row
  return {
    ...rest,
    liftedBy: userOrNull({
      id: lifterId,
      email: lifterEmail,
      firstName: lifterFirstName,
      lastName: lifterLastName,
      isActive: lifterActive,
      isVerified: lifterVerifiedAt !== null,
      deletedAt: lifterDeletedAt,
    }),
  }
}
