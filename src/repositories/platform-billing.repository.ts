/**
 * @file Staff-only reads of billing. Cross-tenant: workspace counts by plan
 * and state, subscriber counts by price, the alerts list, billing columns
 * for a page of workspaces, and the billing records of every workspace a
 * page at a time. One workspace's lists, each bound to its tenant: state
 * history, provider events (ids, type and outcome only) and the
 * subscriptions it has held. Only `services/platform-*.service.ts` may
 * import this file (an eslint rule). Counts leave out the platform tenant
 * and soft-deleted tenants.
 */
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  BILLING_STATES,
  PLAN_KEYS,
  type BillingEventStatus,
  type BillingHistorySource,
  type BillingProvider,
  type BillingProviderMode,
  type BillingState,
  type BillingSubscriptionStanding,
  type PlanKey,
} from '@/constants/billing.constants'
import {
  billingAlertModel,
  billingEventModel,
  billingStateHistoryModel,
  planModel,
  tenantBillingModel,
  tenantBillingSubscriptionModel,
  type BillingAlertRecord,
} from '@/database/models/billing.model'
import { tenantModel } from '@/database/models/tenant.model'
import { db, type DbExecutor } from '@/services/database.service'
import type { BillingStateInput } from '@/types/billing'
import {
  defineList,
  listPage,
  searchCondition,
  timestampKey,
  timestampSort,
  type ListPage,
  type ListParams,
} from '@/utilities/list-page.utilities'

/**
 * One alert with the workspace it names, or null when it names none or the
 * workspace is archived or deleted (its name is not shown then).
 */
export interface BillingAlertListRow {
  alert: BillingAlertRecord
  tenant: { id: string; name: string; slug: string } | null
}

/**
 * The billing columns staff see beside a workspace.
 */
export interface TenantBillingSummary {
  tenantId: string
  state: BillingState
  planKey: PlanKey
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  pastDueSince: Date | null
  haltedAt: Date | null
  pausedAt: Date | null
  disputeOpen: boolean
}

/**
 * A workspace's stored billing fields, enough to tell its effective state.
 */
export interface TenantBillingStateRow extends BillingStateInput {
  tenantId: string
}

/**
 * The alerts list, newest first by default; `search` matches the message.
 * @param search - The parsed search, or undefined.
 * @returns The list definition.
 */
export function billingAlertList(search: string | undefined) {
  return defineList({
    name: 'platform-billing-alerts',
    base: (executor, seek) =>
      executor
        .select({
          id: billingAlertModel.id,
          alert: billingAlertModel,
          tenant: { id: tenantModel.id, name: tenantModel.name, slug: tenantModel.slug },
          sortAt: timestampKey(billingAlertModel.at),
        })
        .from(billingAlertModel)
        .leftJoin(
          tenantModel,
          and(eq(billingAlertModel.tenantId, tenantModel.id), isNull(tenantModel.deletedAt))
        )
        .where(and(searchCondition(search, [sql`lower(${billingAlertModel.message})`]), seek))
        .$dynamic(),
    id: billingAlertModel.id,
    sorts: {
      '-at': [timestampSort(billingAlertModel.at, 'desc', 'sortAt')],
      at: [timestampSort(billingAlertModel.at, 'asc', 'sortAt')],
    },
    toItem: ({ id: _id, sortAt: _at, alert, tenant }): BillingAlertListRow => ({
      alert,
      tenant,
    }),
  })
}

/**
 * One state change of a workspace, as the staff history list shows it.
 */
export interface BillingHistoryListItem {
  id: string
  from: BillingState | null
  to: BillingState
  cause: string
  source: BillingHistorySource
  at: Date
}

/**
 * The staff history list's filters.
 */
export interface BillingHistoryFilters {
  sources: BillingHistorySource[] | undefined
}

/**
 * One workspace's state changes, newest first by default; `search` matches
 * the from and to states and the cause. Its cursors are bound to the tenant.
 * @param tenantId - The workspace.
 * @param search - The parsed search, or undefined.
 * @param filters - The sources.
 * @returns The list definition.
 */
export function billingHistoryList(
  tenantId: string,
  search: string | undefined,
  filters: BillingHistoryFilters
) {
  const history = billingStateHistoryModel
  return defineList({
    name: 'platform-tenant-billing-history',
    base: (executor, seek) =>
      executor
        .select({
          id: history.id,
          fromState: history.fromState,
          toState: history.toState,
          cause: history.cause,
          source: history.source,
          at: history.at,
          sortAt: timestampKey(history.at),
        })
        .from(history)
        .where(
          and(
            eq(history.tenantId, tenantId),
            filters.sources === undefined ? undefined : inArray(history.source, filters.sources),
            searchCondition(search, [
              sql`lower(${history.fromState})`,
              sql`lower(${history.toState})`,
              sql`lower(${history.cause})`,
            ]),
            seek
          )
        )
        .$dynamic(),
    id: history.id,
    sorts: {
      '-at': [timestampSort(history.at, 'desc', 'sortAt')],
      at: [timestampSort(history.at, 'asc', 'sortAt')],
    },
    bound: { tenantId },
    toItem: (row): BillingHistoryListItem => ({
      id: row.id,
      from: row.fromState,
      to: row.toState,
      cause: row.cause,
      source: row.source,
      at: row.at,
    }),
  })
}

/**
 * One provider event of a workspace, as the staff events list shows it: its
 * type, outcome and times, never its provider ids or payload.
 */
export interface BillingEventListItem {
  id: string
  type: string
  status: BillingEventStatus
  provider: BillingProvider
  mode: BillingProviderMode
  receivedAt: Date
  processedAt: Date | null
  /**
   * How many times an outcome was recorded on the row (handled, or given up
   * on), 0 or 1 in practice; never the number of job attempts.
   */
  recordedOutcomes: number
  error: string | null
}

/**
 * The staff events list's filters.
 */
export interface BillingEventFilters {
  statuses: BillingEventStatus[] | undefined
}

/**
 * The condition that a stored event has a status.
 * @param status - The status.
 * @returns The condition over `billing_events`.
 */
function eventStatusCondition(status: BillingEventStatus): SQL | undefined {
  const event = billingEventModel
  switch (status) {
    case 'processed': {
      return and(isNotNull(event.processedAt), isNull(event.error))
    }
    case 'unused': {
      return and(isNotNull(event.processedAt), isNotNull(event.error))
    }
    case 'failed': {
      return and(isNull(event.processedAt), isNotNull(event.error))
    }
    case 'pending': {
      return and(isNull(event.processedAt), isNull(event.error))
    }
  }
}

/**
 * A stored event's status, from its processed time and error.
 * @param processedAt - When it was handled, or null.
 * @param error - Why it changed nothing or failed, or null.
 * @returns The status.
 */
function eventStatusOf(processedAt: Date | null, error: string | null): BillingEventStatus {
  if (processedAt !== null) return error === null ? 'processed' : 'unused'
  return error === null ? 'pending' : 'failed'
}

/**
 * One workspace's provider events by receipt, newest first by default;
 * `search` matches the type and the error. Its cursors are bound to the
 * tenant.
 * @param tenantId - The workspace.
 * @param search - The parsed search, or undefined.
 * @param filters - The statuses.
 * @returns The list definition.
 */
export function billingEventList(
  tenantId: string,
  search: string | undefined,
  filters: BillingEventFilters
) {
  const event = billingEventModel
  const statusMatch =
    filters.statuses === undefined
      ? undefined
      : or(...filters.statuses.map((status) => eventStatusCondition(status)))
  return defineList({
    name: 'platform-tenant-billing-events',
    base: (executor, seek) =>
      executor
        .select({
          id: event.id,
          type: event.type,
          provider: event.provider,
          mode: event.mode,
          receivedAt: event.receivedAt,
          processedAt: event.processedAt,
          attempts: event.attempts,
          error: event.error,
          sortAt: timestampKey(event.receivedAt),
        })
        .from(event)
        .where(
          and(
            eq(event.tenantId, tenantId),
            statusMatch,
            searchCondition(search, [sql`lower(${event.type})`, sql`lower(${event.error})`]),
            seek
          )
        )
        .$dynamic(),
    id: event.id,
    sorts: {
      '-at': [timestampSort(event.receivedAt, 'desc', 'sortAt')],
      at: [timestampSort(event.receivedAt, 'asc', 'sortAt')],
    },
    bound: { tenantId },
    toItem: (row): BillingEventListItem => ({
      id: row.id,
      type: row.type,
      status: eventStatusOf(row.processedAt, row.error),
      provider: row.provider,
      mode: row.mode,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      recordedOutcomes: row.attempts,
      error: row.error,
    }),
  })
}

/**
 * One subscription a workspace has held as its current one, as the staff
 * subscriptions list shows it.
 */
export interface BillingSubscriptionListItem {
  id: string
  subscriptionId: string
  provider: BillingProvider
  mode: BillingProviderMode
  firstSeenAt: Date
  standing: BillingSubscriptionStanding
}

/**
 * The staff subscriptions list's filters.
 */
export interface BillingSubscriptionFilters {
  providers: BillingProvider[] | undefined
  modes: BillingProviderMode[] | undefined
}

/**
 * One workspace's held subscriptions, newest first seen by default;
 * `search` matches the subscription id. Each row says whether the billing
 * row holds it now as its current, pending or next subscription, in the
 * same provider and mode. Its cursors are bound to the tenant.
 * @param tenantId - The workspace.
 * @param search - The parsed search, or undefined.
 * @param filters - The providers and modes.
 * @returns The list definition.
 */
export function billingSubscriptionList(
  tenantId: string,
  search: string | undefined,
  filters: BillingSubscriptionFilters
) {
  const held = tenantBillingSubscriptionModel
  const row = tenantBillingModel
  const standing = sql<BillingSubscriptionStanding>`case
    when ${row.provider} is distinct from ${held.provider} or ${row.providerMode} is distinct from ${held.mode} then 'earlier'
    when ${held.subscriptionId} = ${row.providerSubscriptionId} then 'current'
    when ${held.subscriptionId} = ${row.pendingSubscriptionId} then 'pending'
    when ${held.subscriptionId} = ${row.nextSubscriptionId} then 'next'
    else 'earlier' end`
  return defineList({
    name: 'platform-tenant-billing-subscriptions',
    base: (executor, seek) =>
      executor
        .select({
          id: held.id,
          subscriptionId: held.subscriptionId,
          provider: held.provider,
          mode: held.mode,
          firstSeenAt: held.firstSeenAt,
          standing,
          sortFirstSeen: timestampKey(held.firstSeenAt),
        })
        .from(held)
        .leftJoin(row, eq(row.tenantId, held.tenantId))
        .where(
          and(
            eq(held.tenantId, tenantId),
            eq(held.role, 'held'),
            filters.providers === undefined ? undefined : inArray(held.provider, filters.providers),
            filters.modes === undefined ? undefined : inArray(held.mode, filters.modes),
            searchCondition(search, [sql`lower(${held.subscriptionId})`]),
            seek
          )
        )
        .$dynamic(),
    id: held.id,
    sorts: {
      '-firstSeen': [timestampSort(held.firstSeenAt, 'desc', 'sortFirstSeen')],
      firstSeen: [timestampSort(held.firstSeenAt, 'asc', 'sortFirstSeen')],
    },
    bound: { tenantId },
    toItem: ({ sortFirstSeen: _sort, ...item }): BillingSubscriptionListItem => item,
  })
}

/**
 * Query access for the staff billing views.
 */
export class PlatformBillingRepository {
  /**
   * Live customer workspaces by stored plan and state, zero-filled. The plan
   * is the one the record stores, not the effective plan: a trialing record
   * stores Paid, so it counts under Paid.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns A count for every plan key and state.
   */
  async countTenantsByPlanAndState(
    executor: DbExecutor = db
  ): Promise<Record<PlanKey, Record<BillingState, number>>> {
    const rows = await executor
      .select({ plan: planModel.key, state: tenantBillingModel.state, total: count() })
      .from(tenantBillingModel)
      .innerJoin(planModel, eq(tenantBillingModel.planId, planModel.id))
      .innerJoin(tenantModel, eq(tenantBillingModel.tenantId, tenantModel.id))
      .where(and(isNull(tenantModel.deletedAt), eq(tenantModel.isPlatform, false)))
      .groupBy(planModel.key, tenantBillingModel.state)
    const result = Object.fromEntries(
      PLAN_KEYS.map((plan) => [plan, Object.fromEntries(BILLING_STATES.map((state) => [state, 0]))])
    ) as Record<PlanKey, Record<BillingState, number>>
    for (const row of rows) result[row.plan][row.state] = row.total
    return result
  }

  /**
   * Live paying workspaces (active or past due) by the price they hold.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Subscriber counts keyed by price id.
   */
  async countSubscribersByPrice(executor: DbExecutor = db): Promise<Record<string, number>> {
    const rows = await executor
      .select({ priceId: tenantBillingModel.priceId, total: count() })
      .from(tenantBillingModel)
      .innerJoin(tenantModel, eq(tenantBillingModel.tenantId, tenantModel.id))
      .where(
        and(
          isNull(tenantModel.deletedAt),
          eq(tenantModel.isPlatform, false),
          inArray(tenantBillingModel.state, ['active', 'past_due'])
        )
      )
      .groupBy(tenantBillingModel.priceId)
    const result: Record<string, number> = {}
    for (const row of rows) if (row.priceId !== null) result[row.priceId] = row.total
    return result
  }

  /**
   * One page of staff alerts, newest first unless asked otherwise.
   * @param params - The parsed shared list params.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listAlerts(
    params: ListParams,
    executor: DbExecutor = db
  ): Promise<ListPage<BillingAlertListRow>> {
    return listPage(executor, billingAlertList(params.search), params)
  }

  /**
   * One page of a workspace's state changes.
   * @param tenantId - The workspace.
   * @param params - The parsed shared list params.
   * @param filters - The sources.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listHistoryPage(
    tenantId: string,
    params: ListParams,
    filters: BillingHistoryFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<BillingHistoryListItem>> {
    return listPage(executor, billingHistoryList(tenantId, params.search, filters), params)
  }

  /**
   * One page of a workspace's provider events.
   * @param tenantId - The workspace.
   * @param params - The parsed shared list params.
   * @param filters - The statuses.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listEventsPage(
    tenantId: string,
    params: ListParams,
    filters: BillingEventFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<BillingEventListItem>> {
    return listPage(executor, billingEventList(tenantId, params.search, filters), params)
  }

  /**
   * One page of the subscriptions a workspace has held.
   * @param tenantId - The workspace.
   * @param params - The parsed shared list params.
   * @param filters - The providers and modes.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async listSubscriptionsPage(
    tenantId: string,
    params: ListParams,
    filters: BillingSubscriptionFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<BillingSubscriptionListItem>> {
    return listPage(executor, billingSubscriptionList(tenantId, params.search, filters), params)
  }

  /**
   * One page of live customer workspaces' billing records, in tenant id
   * order, after `afterTenantId`.
   * @param afterTenantId - The last tenant id of the previous page, or undefined for the first page.
   * @param limit - The page size.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page; shorter than `limit` on the last one.
   */
  async pageBillingStates(
    afterTenantId: string | undefined,
    limit: number,
    executor: DbExecutor = db
  ): Promise<TenantBillingStateRow[]> {
    return executor
      .select({
        tenantId: tenantBillingModel.tenantId,
        state: tenantBillingModel.state,
        trialEndsAt: tenantBillingModel.trialEndsAt,
        currentPeriodEnd: tenantBillingModel.currentPeriodEnd,
        cancelAtPeriodEnd: tenantBillingModel.cancelAtPeriodEnd,
        haltedAt: tenantBillingModel.haltedAt,
        pausedAt: tenantBillingModel.pausedAt,
      })
      .from(tenantBillingModel)
      .innerJoin(tenantModel, eq(tenantBillingModel.tenantId, tenantModel.id))
      .where(
        and(
          isNull(tenantModel.deletedAt),
          eq(tenantModel.isPlatform, false),
          afterTenantId === undefined ? undefined : gt(tenantBillingModel.tenantId, afterTenantId)
        )
      )
      .orderBy(asc(tenantBillingModel.tenantId))
      .limit(limit)
  }

  /**
   * The billing columns for a set of workspaces.
   * @param ids - The workspace ids.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One summary per workspace that has a billing record.
   */
  async billingColumnsForTenants(
    ids: readonly string[],
    executor: DbExecutor = db
  ): Promise<TenantBillingSummary[]> {
    if (ids.length === 0) return []
    return executor
      .select({
        tenantId: tenantBillingModel.tenantId,
        state: tenantBillingModel.state,
        planKey: planModel.key,
        trialEndsAt: tenantBillingModel.trialEndsAt,
        currentPeriodEnd: tenantBillingModel.currentPeriodEnd,
        cancelAtPeriodEnd: tenantBillingModel.cancelAtPeriodEnd,
        pastDueSince: tenantBillingModel.pastDueSince,
        haltedAt: tenantBillingModel.haltedAt,
        pausedAt: tenantBillingModel.pausedAt,
        disputeOpen: tenantBillingModel.disputeOpen,
      })
      .from(tenantBillingModel)
      .innerJoin(planModel, eq(tenantBillingModel.planId, planModel.id))
      .where(inArray(tenantBillingModel.tenantId, [...ids]))
  }
}
