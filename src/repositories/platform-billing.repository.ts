/**
 * @file Staff-only, cross-tenant reads of billing: workspace counts by plan
 * and state, subscriber counts by price, the alerts list, billing columns
 * for a page of workspaces, and the billing records of every workspace a
 * page at a time. Only `services/platform-*.service.ts` may import
 * this file (an eslint rule). Counts leave out the platform tenant and
 * soft-deleted tenants.
 */
import { and, asc, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import {
  BILLING_STATES,
  PLAN_KEYS,
  type BillingState,
  type PlanKey,
} from '@/constants/billing.constants'
import {
  billingAlertModel,
  planModel,
  tenantBillingModel,
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
