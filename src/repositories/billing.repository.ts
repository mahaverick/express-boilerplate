/**
 * @file Query access to a workspace's billing record and the tables around
 * it: state history, provider events, staff alerts, banner dismissals,
 * upgrade requests and the one-trial-per-person claim. It does not extend
 * `BaseRepository`, which requires a `deletedAt` column these tables have no
 * use for. Consumers create their own instance at module scope.
 */
import { and, asc, desc, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { BillingState } from '@/constants/billing.constants'
import {
  billingAlertModel,
  billingEventModel,
  billingStateHistoryModel,
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
   * Mark an event handled. Counts the attempt and clears any earlier error.
   * @param id - The stored event's id.
   * @param executor - Where to run the query. Defaults to the pool.
   */
  async markEventProcessed(id: string, executor: DbExecutor = db): Promise<void> {
    await executor
      .update(billingEventModel)
      .set({
        processedAt: sql`now()`,
        attempts: sql`${billingEventModel.attempts} + 1`,
        error: null,
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
    const claimable = tx
      .select({ tenantId: tenantBillingModel.tenantId })
      .from(tenantBillingModel)
      .where(and(isNull(column), where))
      .orderBy(asc(tenantBillingModel.tenantId))
      .limit(limit)
      .for('update', { skipLocked: true })
    return tx
      .update(tenantBillingModel)
      .set({ [property]: sql`now()` })
      .where(
        and(isNull(column), where, sql`${tenantBillingModel.tenantId} = any(array(${claimable}))`)
      )
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
