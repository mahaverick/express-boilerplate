/**
 * @file Query access to a workspace's billing record and the tables around
 * it: state history, provider events, staff alerts, banner dismissals,
 * upgrade requests and the one-trial-per-person claim. It does not extend
 * `BaseRepository`, which requires a `deletedAt` column these tables have no
 * use for. Consumers create their own instance at module scope.
 */
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type {
  BillingProvider,
  BillingProviderMode,
  BillingState,
} from '@/constants/billing.constants'
import {
  billingAlertModel,
  billingEventModel,
  billingStateHistoryModel,
  planPriceModel,
  tenantBillingModel,
  upgradeRequestModel,
  userBannerDismissalModel,
  userTrialModel,
  type BillingAlertRecord,
  type BillingEventRecord,
  type BillingStateHistoryRecord,
  type NewBillingAlert,
  type NewBillingEvent,
  type NewBillingStateHistory,
  type NewTenantBilling,
  type NewUpgradeRequest,
  type TenantBillingRecord,
  type UpgradeRequest,
} from '@/database/models/billing.model'
import { tenantModel } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The longest error text `billing_events.error` stores.
 */
const EVENT_ERROR_MAX_LENGTH = 500

/**
 * How often `openUpgradeRequest` retries when the open request it found
 * conflicting is fulfilled before it can be read.
 */
const OPEN_REQUEST_ATTEMPTS = 3

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many days before a trial ends its ending reminder goes out.
 */
const TRIAL_ENDING_NOTICE_DAYS = 3

/**
 * The same, in milliseconds.
 */
const TRIAL_ENDING_NOTICE_MS = TRIAL_ENDING_NOTICE_DAYS * DAY_MS

/**
 * The trial length, in days, that a trial must exceed to get a halfway reminder.
 */
const MIDPOINT_MIN_TRIAL_DAYS = 6

/**
 * The reminder and notice timestamps `claimDue` can claim. Each is null until
 * its message goes out.
 */
type ReminderColumn =
  | typeof tenantBillingModel.trialMidpointSentAt
  | typeof tenantBillingModel.trialReminder3dSentAt
  | typeof tenantBillingModel.trialReminderLastDaySentAt
  | typeof tenantBillingModel.trialEndedNotifiedAt
  | typeof tenantBillingModel.winback7dSentAt
  | typeof tenantBillingModel.winback30dSentAt
  | typeof tenantBillingModel.lifecycleCancelSentAt

/**
 * The running payment provider and mode. A scheduled query keeps the rows
 * whose provider and mode are unset or match, since this provider cannot
 * read another's subscription ids.
 */
export interface ProviderScope {
  kind: BillingProvider
  mode: BillingProviderMode
}

/**
 * The condition that a row's provider and mode are unset or match the scope.
 * @param scope - The running provider and mode.
 * @returns The condition over `tenant_billing`.
 */
function ofProvider(scope: ProviderScope): SQL | undefined {
  return and(
    or(isNull(tenantBillingModel.provider), eq(tenantBillingModel.provider, scope.kind)),
    or(isNull(tenantBillingModel.providerMode), eq(tenantBillingModel.providerMode, scope.mode))
  )
}

/**
 * A timestamp bound for raw `sql`.
 * @param date - The time.
 * @returns The bound value, cast.
 */
function at(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`
}

/**
 * The condition that the row's workspace is an active customer workspace:
 * not suspended, archived or deleted. Its row is only read, so a claim
 * takes no lock on it.
 * @returns The condition over `tenant_billing`.
 */
function isWorkspaceActive(): SQL {
  return sql`exists (select 1 from ${tenantModel} where ${tenantModel.id} = ${tenantBillingModel.tenantId} and ${tenantModel.lifecycleState} = 'active' and ${tenantModel.deletedAt} is null and not ${tenantModel.isPlatform})`
}

/**
 * One field of a workspace's newest history row into `free`, as a scalar
 * subquery. It rides `billing_state_history_tenant_at_idx` backwards.
 * @param field - The field to read.
 * @returns The subquery over `tenant_billing`.
 */
function latestFree(field: SQL): SQL {
  return sql`(select ${field} from ${billingStateHistoryModel} where ${billingStateHistoryModel.tenantId} = ${tenantBillingModel.tenantId} and ${billingStateHistoryModel.toState} = 'free' order by ${billingStateHistoryModel.at} desc, ${billingStateHistoryModel.id} desc limit 1)`
}

/**
 * The columns a versioned update may change: everything but the key, the
 * version and the update time, which the update sets itself.
 */
type TenantBillingPatch = Partial<Omit<NewTenantBilling, 'tenantId' | 'version' | 'updatedAt'>>

/**
 * Query access to `tenant_billing`, its history, events, alerts, banner
 * dismissals, upgrade requests and `user_trials`.
 */
export class BillingRepository {
  /**
   * Insert a workspace's billing record.
   * @param row - The row's column values.
   * @param tx - The open transaction.
   * @returns The inserted row.
   */
  async insertForTenant(row: NewTenantBilling, tx: DbTransaction): Promise<TenantBillingRecord> {
    const [created] = await tx.insert(tenantBillingModel).values(row).returning()
    if (created === undefined) throw new HttpError('Insert returned no row', 500)
    return created
  }

  /**
   * Insert a workspace's billing record unless it has one.
   * @param row - The row's column values.
   * @param tx - The open transaction.
   */
  async insertIfAbsent(row: NewTenantBilling, tx: DbTransaction): Promise<void> {
    await tx.insert(tenantBillingModel).values(row).onConflictDoNothing()
  }

  /**
   * Find a workspace's billing record.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when the workspace has none.
   */
  async findByTenantId(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<TenantBillingRecord | undefined> {
    const [row] = await executor
      .select()
      .from(tenantBillingModel)
      .where(eq(tenantBillingModel.tenantId, tenantId))
    return row
  }

  /**
   * Lock a workspace's billing record `FOR NO KEY UPDATE`, the seat lock.
   *
   * Lock order: take it after the user row, the owner rows, the memberships
   * and the platform-role row, and before any invitation or membership-row
   * write and before the tenant or settings row.
   * @param tenantId - The workspace.
   * @param tx - The open transaction.
   * @returns The locked row, or undefined when the workspace has none.
   */
  async lockByTenantId(
    tenantId: string,
    tx: DbTransaction
  ): Promise<TenantBillingRecord | undefined> {
    const [row] = await tx
      .select()
      .from(tenantBillingModel)
      .where(eq(tenantBillingModel.tenantId, tenantId))
      .for('no key update')
    return row
  }

  /**
   * Change a billing record only if its version is still `expectedVersion`.
   * The update adds one to `version` and sets `updated_at`.
   * @param tenantId - The workspace.
   * @param expectedVersion - The version the caller read.
   * @param patch - The columns to change.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when the version was stale.
   */
  async updateVersioned(
    tenantId: string,
    expectedVersion: number,
    patch: TenantBillingPatch,
    tx: DbTransaction
  ): Promise<TenantBillingRecord | undefined> {
    const [row] = await tx
      .update(tenantBillingModel)
      .set({
        ...patch,
        version: sql`${tenantBillingModel.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tenantBillingModel.tenantId, tenantId),
          eq(tenantBillingModel.version, expectedVersion)
        )
      )
      .returning()
    return row
  }

  /**
   * Find the record that holds a provider subscription as its current,
   * pending or next subscription.
   * @param subscriptionId - The provider's subscription id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when no record holds it.
   */
  async findBySubscriptionId(
    subscriptionId: string,
    executor: DbExecutor = db
  ): Promise<TenantBillingRecord | undefined> {
    const [row] = await executor
      .select()
      .from(tenantBillingModel)
      .where(
        or(
          eq(tenantBillingModel.providerSubscriptionId, subscriptionId),
          eq(tenantBillingModel.pendingSubscriptionId, subscriptionId),
          eq(tenantBillingModel.nextSubscriptionId, subscriptionId)
        )
      )
    return row
  }

  /**
   * Append one state change to a workspace's history.
   * @param entry - The change.
   * @param tx - The open transaction.
   */
  async appendHistory(entry: NewBillingStateHistory, tx: DbTransaction): Promise<void> {
    await tx.insert(billingStateHistoryModel).values(entry)
  }

  /**
   * A workspace's state changes, newest first.
   * @param tenantId - The workspace.
   * @param limit - The most rows to return.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listHistory(
    tenantId: string,
    limit: number,
    executor: DbExecutor = db
  ): Promise<BillingStateHistoryRecord[]> {
    return executor
      .select()
      .from(billingStateHistoryModel)
      .where(eq(billingStateHistoryModel.tenantId, tenantId))
      .orderBy(desc(billingStateHistoryModel.at), desc(billingStateHistoryModel.id))
      .limit(limit)
  }

  /**
   * Record a provider event once. A second delivery of the same event id
   * changes nothing.
   * @param row - The event's ids, type and workspace; never its body.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns `inserted` for a new event, `duplicate` for one already stored.
   */
  async recordEvent(
    row: NewBillingEvent,
    executor: DbExecutor = db
  ): Promise<'inserted' | 'duplicate'> {
    const inserted = await executor
      .insert(billingEventModel)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: billingEventModel.id })
    return inserted.length === 0 ? 'duplicate' : 'inserted'
  }

  /**
   * Find a stored event by the provider's own id.
   * @param provider - The provider.
   * @param mode - The provider mode.
   * @param providerEventId - The provider's event id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when none is stored.
   */
  async findEvent(
    provider: BillingEventRecord['provider'],
    mode: BillingEventRecord['mode'],
    providerEventId: string,
    executor: DbExecutor = db
  ): Promise<BillingEventRecord | undefined> {
    const [row] = await executor
      .select()
      .from(billingEventModel)
      .where(
        and(
          eq(billingEventModel.provider, provider),
          eq(billingEventModel.mode, mode),
          eq(billingEventModel.providerEventId, providerEventId)
        )
      )
    return row
  }

  /**
   * Find a stored event by its row id.
   * @param id - The stored event's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when none is stored.
   */
  async findEventById(
    id: string,
    executor: DbExecutor = db
  ): Promise<BillingEventRecord | undefined> {
    const [row] = await executor
      .select()
      .from(billingEventModel)
      .where(eq(billingEventModel.id, id))
    return row
  }

  /**
   * Record the workspace an event resolved to, before it is handled, so a
   * handling that later fails for good can still name the workspace.
   * @param id - The stored event's id.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async setEventTenant(id: string, tenantId: string, executor: DbExecutor = db): Promise<void> {
    await executor.update(billingEventModel).set({ tenantId }).where(eq(billingEventModel.id, id))
  }

  /**
   * Mark an event handled. Counts the attempt and replaces any earlier error
   * with the outcome's, or clears it.
   * @param id - The stored event's id.
   * @param outcome - What handling it found.
   * @param outcome.tenantId - The workspace it resolved to; left unchanged when absent.
   * @param outcome.error - Why it changed nothing, such as `unknown_subscription`; cut to the column's length.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async markEventProcessed(
    id: string,
    outcome: { tenantId?: string; error?: string } = {},
    executor: DbExecutor = db
  ): Promise<void> {
    await executor
      .update(billingEventModel)
      .set({
        processedAt: sql`now()`,
        attempts: sql`${billingEventModel.attempts} + 1`,
        error: outcome.error?.slice(0, EVENT_ERROR_MAX_LENGTH) ?? null,
        ...(outcome.tenantId !== undefined && { tenantId: outcome.tenantId }),
      })
      .where(eq(billingEventModel.id, id))
  }

  /**
   * Record a failed attempt to handle an event.
   * @param id - The stored event's id.
   * @param error - What went wrong; cut to the column's length.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async markEventFailed(id: string, error: string, executor: DbExecutor = db): Promise<void> {
    await executor
      .update(billingEventModel)
      .set({
        attempts: sql`${billingEventModel.attempts} + 1`,
        error: error.slice(0, EVENT_ERROR_MAX_LENGTH),
      })
      .where(eq(billingEventModel.id, id))
  }

  /**
   * A workspace's provider events, newest first.
   * @param tenantId - The workspace.
   * @param limit - The most rows to return.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listEvents(
    tenantId: string,
    limit: number,
    executor: DbExecutor = db
  ): Promise<BillingEventRecord[]> {
    return executor
      .select()
      .from(billingEventModel)
      .where(eq(billingEventModel.tenantId, tenantId))
      .orderBy(desc(billingEventModel.receivedAt), desc(billingEventModel.id))
      .limit(limit)
  }

  /**
   * Add a staff alert.
   * @param row - The alert.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row.
   */
  async insertAlert(row: NewBillingAlert, executor: DbExecutor = db): Promise<BillingAlertRecord> {
    const [created] = await executor.insert(billingAlertModel).values(row).returning()
    if (created === undefined) throw new HttpError('Insert returned no row', 500)
    return created
  }

  /**
   * Whether a workspace already has an alert of a kind whose message names a
   * text, such as a subscription id, so a repeated sync does not raise it again.
   * @param tenantId - The workspace, or null for the alerts that name none.
   * @param kind - The alert kind.
   * @param text - The text the message must contain, matched literally.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when such an alert exists.
   */
  async hasAlertNaming(
    tenantId: string | null,
    kind: BillingAlertRecord['kind'],
    text: string,
    executor: DbExecutor = db
  ): Promise<boolean> {
    const [row] = await executor
      .select({ id: billingAlertModel.id })
      .from(billingAlertModel)
      .where(
        and(
          tenantId === null
            ? isNull(billingAlertModel.tenantId)
            : eq(billingAlertModel.tenantId, tenantId),
          eq(billingAlertModel.kind, kind),
          sql`strpos(${billingAlertModel.message}, ${text}) > 0`
        )
      )
      .limit(1)
    return row !== undefined
  }

  /**
   * Claim up to `limit` records for a reminder: set `column` to now on rows
   * where it is null and `where` holds, and return those rows. A row another
   * transaction holds locked is skipped, so each row is claimed once.
   *
   * The ids are collected with `= any(array(...))`, which runs the locking
   * subquery once, so the update takes at most `limit` rows.
   * @param column - The reminder column to claim.
   * @param where - The condition a row must meet, over `tenant_billing`.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async claimDue(
    column: ReminderColumn,
    where: SQL,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const property = Object.entries(getTableColumns(tenantBillingModel)).find(
      ([, candidate]) => candidate === column
    )?.[0]
    if (property === undefined) throw new HttpError('Unknown reminder column', 500)
    return this.#claim({ [property]: sql`now()` }, isNull(column), where, limit, tx)
  }

  /**
   * Claim up to `limit` records: apply `set` to rows where `unclaimed` and
   * `where` hold, and return those rows. A row another transaction holds
   * locked is skipped, so each row is claimed once; both conditions are
   * checked again by the update, so a row claimed by a transaction that
   * committed meanwhile is not claimed twice.
   *
   * The ids are collected with `= any(array(...))`, which runs the locking
   * subquery once, so the update takes at most `limit` rows.
   * @param set - What the claim writes.
   * @param unclaimed - The condition that the row is not yet claimed.
   * @param where - The condition a row must meet, over `tenant_billing`.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async #claim(
    set: Record<string, SQL>,
    unclaimed: SQL,
    where: SQL,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const claimable = tx
      .select({ tenantId: tenantBillingModel.tenantId })
      .from(tenantBillingModel)
      .where(and(unclaimed, where))
      .orderBy(asc(tenantBillingModel.tenantId))
      .limit(limit)
      .for('update', { skipLocked: true })
    return tx
      .update(tenantBillingModel)
      .set(set)
      .where(and(unclaimed, where, sql`${tenantBillingModel.tenantId} = any(array(${claimable}))`))
      .returning()
  }

  /**
   * Records in `state` that meet `where`, for a scheduled job to act on.
   * @param state - The billing state.
   * @param where - An extra condition over `tenant_billing`, or undefined.
   * @param limit - The most rows to return.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows, by workspace id.
   */
  async listDueForState(
    state: BillingState,
    where: SQL | undefined,
    limit: number,
    executor: DbExecutor = db
  ): Promise<TenantBillingRecord[]> {
    return executor
      .select()
      .from(tenantBillingModel)
      .where(and(eq(tenantBillingModel.state, state), where))
      .orderBy(asc(tenantBillingModel.tenantId))
      .limit(limit)
  }

  /**
   * Remember that a user dismissed a banner for a workspace.
   * @param userId - The user.
   * @param tenantId - The workspace.
   * @param banner - The banner key.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async dismissBanner(
    userId: string,
    tenantId: string,
    banner: string,
    executor: DbExecutor = db
  ): Promise<void> {
    await executor
      .insert(userBannerDismissalModel)
      .values({ userId, tenantId, bannerKey: banner })
      .onConflictDoNothing()
  }

  /**
   * The banners a user dismissed for a workspace.
   * @param userId - The user.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The banner keys.
   */
  async listDismissals(
    userId: string,
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<string[]> {
    const rows = await executor
      .select({ bannerKey: userBannerDismissalModel.bannerKey })
      .from(userBannerDismissalModel)
      .where(
        and(
          eq(userBannerDismissalModel.userId, userId),
          eq(userBannerDismissalModel.tenantId, tenantId)
        )
      )
      .orderBy(asc(userBannerDismissalModel.bannerKey))
    return rows.map((row) => row.bannerKey)
  }

  /**
   * Open an upgrade request, or return the one this user already has open
   * for the workspace. An open request past its expiry is reopened.
   * @param row - The request.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The open request, and whether one was already open.
   */
  async openUpgradeRequest(
    row: NewUpgradeRequest,
    executor: DbExecutor = db
  ): Promise<{ request: UpgradeRequest; alreadyRequested: boolean }> {
    for (let attempt = 0; attempt < OPEN_REQUEST_ATTEMPTS; attempt += 1) {
      const [opened] = await executor
        .insert(upgradeRequestModel)
        .values(row)
        .onConflictDoUpdate({
          target: [upgradeRequestModel.tenantId, upgradeRequestModel.requestedBy],
          targetWhere: isNull(upgradeRequestModel.fulfilledAt),
          set: {
            entitlementKey: row.entitlementKey ?? null,
            surface: row.surface,
            createdAt: sql`now()`,
            expiresAt: row.expiresAt,
          },
          setWhere: sql`${upgradeRequestModel.expiresAt} <= now()`,
        })
        .returning()
      if (opened !== undefined) return { request: opened, alreadyRequested: false }
      const [existing] = await executor
        .select()
        .from(upgradeRequestModel)
        .where(
          and(
            eq(upgradeRequestModel.tenantId, row.tenantId),
            eq(upgradeRequestModel.requestedBy, row.requestedBy),
            isNull(upgradeRequestModel.fulfilledAt)
          )
        )
      if (existing !== undefined) return { request: existing, alreadyRequested: true }
    }
    throw new HttpError('Upgrade request could not be opened', 500)
  }

  /**
   * A workspace's open upgrade requests that have not expired, oldest first.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listOpenUpgradeRequests(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<UpgradeRequest[]> {
    return executor
      .select()
      .from(upgradeRequestModel)
      .where(
        and(
          eq(upgradeRequestModel.tenantId, tenantId),
          isNull(upgradeRequestModel.fulfilledAt),
          sql`${upgradeRequestModel.expiresAt} > now()`
        )
      )
      .orderBy(asc(upgradeRequestModel.createdAt), asc(upgradeRequestModel.id))
  }

  /**
   * Mark a workspace's open, unexpired upgrade requests fulfilled.
   * @param tenantId - The workspace.
   * @param tx - The open transaction.
   * @returns The requests this call fulfilled.
   */
  async fulfilUpgradeRequests(tenantId: string, tx: DbTransaction): Promise<UpgradeRequest[]> {
    return tx
      .update(upgradeRequestModel)
      .set({ fulfilledAt: sql`now()` })
      .where(
        and(
          eq(upgradeRequestModel.tenantId, tenantId),
          isNull(upgradeRequestModel.fulfilledAt),
          sql`${upgradeRequestModel.expiresAt} > now()`
        )
      )
      .returning()
  }

  /**
   * One page of records that meet `where`, by workspace id after a cursor,
   * for a scheduled job to walk every due row.
   * @param where - The condition over `tenant_billing`.
   * @param afterTenantId - The last workspace id of the previous page, or null for the first.
   * @param limit - The page size.
   * @returns The rows.
   */
  async #listPage(
    where: SQL | undefined,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    return db
      .select()
      .from(tenantBillingModel)
      .where(
        and(
          where,
          afterTenantId === null ? undefined : gt(tenantBillingModel.tenantId, afterTenantId)
        )
      )
      .orderBy(asc(tenantBillingModel.tenantId))
      .limit(limit)
  }

  /**
   * Trials that ended at or before `now`.
   * @param now - The run's time.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listEndedTrials(
    now: Date,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    return this.#listPage(
      and(eq(tenantBillingModel.state, 'trialing'), lte(tenantBillingModel.trialEndsAt, now)),
      afterTenantId,
      limit
    )
  }

  /**
   * Past-due records whose grace after a halt or pause ended at or before `now`.
   * @param now - The run's time.
   * @param graceDays - Days of grace.
   * @param scope - The running provider and mode.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listGraceEnded(
    now: Date,
    graceDays: number,
    scope: ProviderScope,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    const since = sql`coalesce(${tenantBillingModel.haltedAt}, ${tenantBillingModel.pausedAt})`
    return this.#listPage(
      and(
        eq(tenantBillingModel.state, 'past_due'),
        sql`${since} + ${graceDays}::int * interval '1 day' <= ${at(now)}`,
        ofProvider(scope)
      ),
      afterTenantId,
      limit
    )
  }

  /**
   * Active, cancelling records whose period end plus the buffer passed before `now`.
   * @param now - The run's time.
   * @param bufferDays - Days Paid lasts past the period end of a cancelling subscription.
   * @param scope - The running provider and mode.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listCancellingEnded(
    now: Date,
    bufferDays: number,
    scope: ProviderScope,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    return this.#listPage(
      and(
        eq(tenantBillingModel.state, 'active'),
        eq(tenantBillingModel.cancelAtPeriodEnd, true),
        sql`${tenantBillingModel.currentPeriodEnd} + ${bufferDays}::int * interval '1 day' < ${at(now)}`,
        ofProvider(scope)
      ),
      afterTenantId,
      limit
    )
  }

  /**
   * Records with a scheduled interval switch whose current period ended at or before `now`.
   * @param now - The run's time.
   * @param scope - The running provider and mode.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listSwitchesDue(
    now: Date,
    scope: ProviderScope,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    return this.#listPage(
      and(
        inArray(tenantBillingModel.state, ['active', 'past_due']),
        isNotNull(tenantBillingModel.nextSubscriptionId),
        lte(tenantBillingModel.currentPeriodEnd, now),
        ofProvider(scope)
      ),
      afterTenantId,
      limit
    )
  }

  /**
   * Records that hold any subscription, for the daily reconcile.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listWithSubscriptions(
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    return this.#listPage(
      or(
        isNotNull(tenantBillingModel.providerSubscriptionId),
        isNotNull(tenantBillingModel.pendingSubscriptionId),
        isNotNull(tenantBillingModel.nextSubscriptionId)
      ),
      afterTenantId,
      limit
    )
  }

  /**
   * Claim the three-day trial reminder of up to `limit` trials of active
   * workspaces that end after `now` and within three days of it. A trial of
   * three days or less gets none: the whole trial is that window.
   * @param now - The run's time.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async claimTrialEndingReminders(
    now: Date,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const noticeFrom = new Date(now.getTime() + TRIAL_ENDING_NOTICE_MS)
    return this.claimDue(
      tenantBillingModel.trialReminder3dSentAt,
      and(
        eq(tenantBillingModel.state, 'trialing'),
        gt(tenantBillingModel.trialEndsAt, now),
        lte(tenantBillingModel.trialEndsAt, noticeFrom),
        sql`(${tenantBillingModel.trialStartedAt} is null or ${tenantBillingModel.trialEndsAt} - ${tenantBillingModel.trialStartedAt} > make_interval(days => ${TRIAL_ENDING_NOTICE_DAYS}::int))`,
        isWorkspaceActive()
      ) ?? isWorkspaceActive(),
      limit,
      tx
    )
  }

  /**
   * Claim the halfway reminder of up to `limit` trials of active workspaces:
   * trials longer than six days, at least half over at `now`, with three
   * days or more left (the three-day reminder takes over from there). A
   * six-day trial's halfway point is its three-day point, so it gets only
   * the three-day reminder.
   * @param now - The run's time.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async claimTrialMidpointReminders(
    now: Date,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const { trialStartedAt, trialEndsAt } = tenantBillingModel
    const noticeFrom = new Date(now.getTime() + TRIAL_ENDING_NOTICE_MS)
    return this.claimDue(
      tenantBillingModel.trialMidpointSentAt,
      and(
        eq(tenantBillingModel.state, 'trialing'),
        isNotNull(trialStartedAt),
        gte(trialEndsAt, noticeFrom),
        sql`${trialEndsAt} - ${trialStartedAt} > make_interval(days => ${MIDPOINT_MIN_TRIAL_DAYS}::int)`,
        sql`${at(now)} >= ${trialStartedAt} + (${trialEndsAt} - ${trialStartedAt}) / 2`,
        isWorkspaceActive()
      ) ?? isWorkspaceActive(),
      limit,
      tx
    )
  }

  /**
   * Trials of active workspaces that end after `now` and within a day of it,
   * whose last-day reminder is not yet claimed: the candidates for the
   * reminder, which the caller judges in each workspace's time zone.
   * @param now - The run's time.
   * @param afterTenantId - The previous page's last workspace id, or null.
   * @param limit - The page size.
   * @returns The rows.
   */
  async listTrialLastDayCandidates(
    now: Date,
    afterTenantId: string | null,
    limit: number
  ): Promise<TenantBillingRecord[]> {
    const dayAhead = new Date(now.getTime() + DAY_MS)
    return this.#listPage(
      and(
        eq(tenantBillingModel.state, 'trialing'),
        isNull(tenantBillingModel.trialReminderLastDaySentAt),
        gt(tenantBillingModel.trialEndsAt, now),
        lte(tenantBillingModel.trialEndsAt, dayAhead),
        isWorkspaceActive()
      ),
      afterTenantId,
      limit
    )
  }

  /**
   * Claim one workspace's last-day trial reminder, while its trial still
   * runs at `now` and the workspace is active.
   * @param tenantId - The workspace.
   * @param now - The run's time.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed row, or undefined when it is claimed or no longer due.
   */
  async claimTrialLastDayReminder(
    tenantId: string,
    now: Date,
    tx: DbTransaction
  ): Promise<TenantBillingRecord | undefined> {
    const [claimed] = await this.claimDue(
      tenantBillingModel.trialReminderLastDaySentAt,
      and(
        eq(tenantBillingModel.tenantId, tenantId),
        eq(tenantBillingModel.state, 'trialing'),
        gt(tenantBillingModel.trialEndsAt, now),
        isWorkspaceActive()
      ) ?? isWorkspaceActive(),
      1,
      tx
    )
    return claimed
  }

  /**
   * Claim the renewal reminder of up to `limit` active workspaces on a yearly
   * price, not cancelling, whose paid period ends after `now` and within
   * `days` of it. The claim records the period end it is for, so the next
   * period gets its own reminder.
   * @param now - The run's time.
   * @param days - How many days ahead to remind.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async claimRenewalReminders(
    now: Date,
    days: number,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const { currentPeriodEnd, renewalReminderForPeriodEnd, priceId } = tenantBillingModel
    const remindFrom = new Date(now.getTime() + days * DAY_MS)
    const isYearly = sql`exists (select 1 from ${planPriceModel} where ${planPriceModel.id} = ${priceId} and ${planPriceModel.interval} = 'year')`
    return this.#claim(
      { renewalReminderForPeriodEnd: sql`${currentPeriodEnd}` },
      sql`${renewalReminderForPeriodEnd} is distinct from ${currentPeriodEnd}`,
      and(
        eq(tenantBillingModel.state, 'active'),
        eq(tenantBillingModel.cancelAtPeriodEnd, false),
        gt(currentPeriodEnd, now),
        lte(currentPeriodEnd, remindFrom),
        isYearly,
        isWorkspaceActive()
      ) ?? isYearly,
      limit,
      tx
    )
  }

  /**
   * Claim one win-back email of up to `limit` active Free workspaces: those
   * whose latest move to Free came from a trial or a paid state between
   * `fromDays` and `toDays` days before `now`. A claim older than that move
   * belongs to an earlier Free period and counts as unclaimed, so each Free
   * period gets its own emails without a reset. The claim is stamped `now`.
   * @param day - Which win-back email.
   * @param now - The run's time.
   * @param fromDays - The fewest days on Free.
   * @param toDays - The most days on Free, exclusive.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @returns The claimed rows.
   */
  async claimWinbacks(
    day: '7d' | '30d',
    now: Date,
    fromDays: number,
    toDays: number,
    limit: number,
    tx: DbTransaction
  ): Promise<TenantBillingRecord[]> {
    const column =
      day === '7d' ? tenantBillingModel.winback7dSentAt : tenantBillingModel.winback30dSentAt
    const property = day === '7d' ? 'winback7dSentAt' : 'winback30dSentAt'
    const freeSince = latestFree(sql`${billingStateHistoryModel.at}`)
    const freeFrom = latestFree(sql`${billingStateHistoryModel.fromState}`)
    const latest = at(new Date(now.getTime() - fromDays * DAY_MS))
    const earliest = at(new Date(now.getTime() - toDays * DAY_MS))
    const where =
      and(
        eq(tenantBillingModel.state, 'free'),
        sql`${freeFrom} in ('trialing', 'active', 'past_due')`,
        sql`${freeSince} <= ${latest}`,
        sql`${freeSince} > ${earliest}`,
        isWorkspaceActive()
      ) ?? isWorkspaceActive()
    return this.#claim(
      { [property]: at(now) },
      sql`(${column} is null or ${column} < ${freeSince})`,
      where,
      limit,
      tx
    )
  }

  /**
   * Forget a user as the payer of every workspace they pay for, with the
   * billing address they gave, when their account is deleted or purged: the
   * address is theirs. Each row's version moves on, so a sync that read it
   * before writes again from the new row. A payer's own rows only: a
   * workspace another person pays for is untouched.
   *
   * Lock order: the billing rows, after the user row and before any
   * invitation or membership-row write.
   * @param userId - The user.
   * @param tx - The delete's or purge's transaction.
   * @returns The rows as they were before the clear, in workspace order.
   */
  async clearPayer(userId: string, tx: DbTransaction): Promise<TenantBillingRecord[]> {
    const paidFor = await tx
      .select()
      .from(tenantBillingModel)
      .where(eq(tenantBillingModel.payerUserId, userId))
      .orderBy(tenantBillingModel.tenantId)
      .for('no key update')
    if (paidFor.length === 0) return []
    await tx
      .update(tenantBillingModel)
      .set({
        payerUserId: null,
        billingEmail: null,
        version: sql`${tenantBillingModel.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          tenantBillingModel.tenantId,
          paidFor.map((row) => row.tenantId)
        )
      )
    return paidFor
  }

  /**
   * Claim the records of suspended or archived workspaces that still have a
   * subscription to cancel: a current one not yet cancelling (for an archived
   * workspace, cancelling too, since an archive cancels now), a scheduled
   * switch or a checkout. The workspace row is only read, so the claim takes
   * no lock on it.
   * @param scope - The running provider and mode.
   * @param limit - The most rows to claim.
   * @param tx - The open transaction; the claim holds until it ends.
   * @param tenantId - Claim only this workspace's record, for the prompt cancel job.
   * @returns The claimed rows.
   */
  async claimLifecycleCancels(
    scope: ProviderScope,
    limit: number,
    tx: DbTransaction,
    tenantId?: string
  ): Promise<TenantBillingRecord[]> {
    const isSuspendedOrArchived = sql`exists (select 1 from ${tenantModel} where ${tenantModel.id} = ${tenantBillingModel.tenantId} and ${tenantModel.lifecycleState} in ('suspended', 'archived'))`
    const isArchived = sql`exists (select 1 from ${tenantModel} where ${tenantModel.id} = ${tenantBillingModel.tenantId} and ${tenantModel.lifecycleState} = 'archived')`
    const hasRunningCurrent = and(
      inArray(tenantBillingModel.state, ['active', 'past_due']),
      isNotNull(tenantBillingModel.providerSubscriptionId),
      or(eq(tenantBillingModel.cancelAtPeriodEnd, false), isArchived)
    )
    const holdsSubscription = or(
      hasRunningCurrent,
      isNotNull(tenantBillingModel.nextSubscriptionId),
      isNotNull(tenantBillingModel.pendingSubscriptionId)
    )
    const ofTenant = tenantId === undefined ? undefined : eq(tenantBillingModel.tenantId, tenantId)
    return this.claimDue(
      tenantBillingModel.lifecycleCancelSentAt,
      and(isSuspendedOrArchived, holdsSubscription, ofProvider(scope), ofTenant) ??
        isSuspendedOrArchived,
      limit,
      tx
    )
  }

  /**
   * Clear the lifecycle cancel claims that no longer stand: a workspace that
   * is active again, so a later suspension or archive cancels the
   * subscription it holds then; and a workspace archived after its claim was
   * taken (a suspension's cycle-end cancel), so the archive cancels now.
   * `deleted_at` is when the workspace was archived.
   * @param executor - Where to run the query. Defaults to the pool.
   * @param tenantId - Clear only this workspace's claim, for the prompt cancel job.
   * @returns How many claims were cleared.
   */
  async releaseLifecycleCancelClaims(
    executor: DbExecutor = db,
    tenantId?: string
  ): Promise<number> {
    const released = await executor
      .update(tenantBillingModel)
      .set({ lifecycleCancelSentAt: null })
      .where(
        and(
          isNotNull(tenantBillingModel.lifecycleCancelSentAt),
          tenantId === undefined ? undefined : eq(tenantBillingModel.tenantId, tenantId),
          sql`exists (select 1 from ${tenantModel} where ${tenantModel.id} = ${tenantBillingModel.tenantId} and (${tenantModel.lifecycleState} = 'active' or (${tenantModel.lifecycleState} = 'archived' and ${tenantModel.deletedAt} > ${tenantBillingModel.lifecycleCancelSentAt})))`
        )
      )
      .returning({ tenantId: tenantBillingModel.tenantId })
    return released.length
  }

  /**
   * Clear one workspace's lifecycle cancel claim.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async releaseLifecycleCancelClaim(tenantId: string, executor: DbExecutor = db): Promise<void> {
    await executor
      .update(tenantBillingModel)
      .set({ lifecycleCancelSentAt: null })
      .where(eq(tenantBillingModel.tenantId, tenantId))
  }

  /**
   * The workspaces of provider events received since a time that are still
   * unhandled after a failed attempt.
   * @param since - The earliest receipt time.
   * @param scope - The running provider and mode.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The workspace ids, each once.
   */
  async listFailedEventTenantIds(
    since: Date,
    scope: ProviderScope,
    executor: DbExecutor = db
  ): Promise<string[]> {
    const rows = await executor
      .selectDistinct({ tenantId: billingEventModel.tenantId })
      .from(billingEventModel)
      .where(
        and(
          eq(billingEventModel.provider, scope.kind),
          eq(billingEventModel.mode, scope.mode),
          gte(billingEventModel.receivedAt, since),
          isNull(billingEventModel.processedAt),
          isNotNull(billingEventModel.error),
          isNotNull(billingEventModel.tenantId)
        )
      )
    return rows.flatMap((row) => (row.tenantId === null ? [] : [row.tenantId]))
  }

  /**
   * Delete a member's open upgrade requests in one workspace, when they leave
   * or are removed: a request outlives no membership, so its fulfilment
   * never tells someone who is gone. Fulfilled requests are kept.
   * @param tenantId - The workspace.
   * @param userId - The member.
   * @param tx - The membership delete's transaction.
   * @returns How many were deleted.
   */
  async closeOpenUpgradeRequests(
    tenantId: string,
    userId: string,
    tx: DbTransaction
  ): Promise<number> {
    const deleted = await tx
      .delete(upgradeRequestModel)
      .where(
        and(
          eq(upgradeRequestModel.tenantId, tenantId),
          eq(upgradeRequestModel.requestedBy, userId),
          isNull(upgradeRequestModel.fulfilledAt)
        )
      )
      .returning({ id: upgradeRequestModel.id })
    return deleted.length
  }

  /**
   * Delete a user's open upgrade requests in every workspace, when their
   * account is deleted. Fulfilled requests are kept.
   * @param userId - The user.
   * @param tx - The delete's transaction.
   * @returns How many were deleted.
   */
  async closeAllOpenUpgradeRequestsOf(userId: string, tx: DbTransaction): Promise<number> {
    const deleted = await tx
      .delete(upgradeRequestModel)
      .where(
        and(eq(upgradeRequestModel.requestedBy, userId), isNull(upgradeRequestModel.fulfilledAt))
      )
      .returning({ id: upgradeRequestModel.id })
    return deleted.length
  }

  /**
   * Delete the open upgrade requests whose expiry passed at or before `now`.
   * Fulfilled requests are kept.
   * @param now - The run's time.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns How many were deleted.
   */
  async deleteExpiredUpgradeRequests(now: Date, executor: DbExecutor = db): Promise<number> {
    const deleted = await executor
      .delete(upgradeRequestModel)
      .where(and(isNull(upgradeRequestModel.fulfilledAt), lte(upgradeRequestModel.expiresAt, now)))
      .returning({ id: upgradeRequestModel.id })
    return deleted.length
  }

  /**
   * Claim a user's one trial. Two concurrent claims for the same user
   * cannot both succeed.
   * @param userId - The user.
   * @param tx - The open transaction.
   * @returns True when this call claimed the trial, false when it was taken.
   */
  async claimUserTrial(userId: string, tx: DbTransaction): Promise<boolean> {
    const claimed = await tx
      .insert(userTrialModel)
      .values({ userId })
      .onConflictDoNothing()
      .returning({ userId: userTrialModel.userId })
    return claimed.length > 0
  }

  /**
   * The user whose trial a workspace used: its creator, or the owner whose
   * acceptance started a staff-made workspace's trial.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The user's id, or undefined when no trial names the workspace (or its user is gone).
   */
  async findTrialUserId(tenantId: string, executor: DbExecutor = db): Promise<string | undefined> {
    const [row] = await executor
      .select({ userId: userTrialModel.userId })
      .from(userTrialModel)
      .where(eq(userTrialModel.firstTrialTenantId, tenantId))
      .limit(1)
    return row?.userId
  }

  /**
   * Record which workspace used a user's trial.
   * @param userId - The user.
   * @param tenantId - The workspace.
   * @param tx - The open transaction.
   */
  async setFirstTrialTenant(userId: string, tenantId: string, tx: DbTransaction): Promise<void> {
    await tx
      .update(userTrialModel)
      .set({ firstTrialTenantId: tenantId })
      .where(eq(userTrialModel.userId, userId))
  }
}
