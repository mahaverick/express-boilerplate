/**
 * @file Query access to the plans, their prices, the billing settings row and
 * the staff grants on a workspace. It does not extend `BaseRepository`, which
 * requires a `deletedAt` column these tables have no use for. Consumers create
 * their own instance at module scope.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  BillingInterval,
  BillingProvider,
  BillingProviderMode,
  PlanKey,
} from '@/constants/billing.constants'
import {
  billingSettingsModel,
  planModel,
  planPriceModel,
  tenantEntitlementGrantModel,
  type BillingSettingsRecord,
  type EntitlementGrant,
  type NewEntitlementGrant,
  type NewPlanPrice,
  type Plan,
  type PlanPrice,
} from '@/database/models/billing.model'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The plan columns staff may change.
 */
type PlanPatch = Partial<Pick<Plan, 'name' | 'description' | 'entitlements' | 'sortOrder'>>

/**
 * The settings columns staff may change.
 */
type BillingSettingsPatch = Partial<
  Pick<BillingSettingsRecord, 'trialEnabled' | 'trialDays' | 'pastDueGraceDays' | 'updatedBy'>
>

/**
 * Query access to `plans`, `plan_prices`, `billing_settings` and
 * `tenant_entitlement_grants`.
 */
export class PlanRepository {
  /**
   * Every plan, in display order.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listPlans(executor: DbExecutor = db): Promise<Plan[]> {
    return executor.select().from(planModel).orderBy(asc(planModel.sortOrder), asc(planModel.id))
  }

  /**
   * Find a plan by id.
   * @param id - The plan's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined.
   */
  async findPlan(id: string, executor: DbExecutor = db): Promise<Plan | undefined> {
    const [row] = await executor.select().from(planModel).where(eq(planModel.id, id))
    return row
  }

  /**
   * Find a plan by key.
   * @param key - `free` or `paid`.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined.
   */
  async findPlanByKey(key: PlanKey, executor: DbExecutor = db): Promise<Plan | undefined> {
    const [row] = await executor.select().from(planModel).where(eq(planModel.key, key))
    return row
  }

  /**
   * Lock a plan row `FOR NO KEY UPDATE`, so two staff edits of one plan
   * read each other's version.
   * @param id - The plan's id.
   * @param tx - The open transaction.
   * @returns The locked row, or undefined when there is no such plan.
   */
  async lockPlan(id: string, tx: DbTransaction): Promise<Plan | undefined> {
    const [row] = await tx.select().from(planModel).where(eq(planModel.id, id)).for('no key update')
    return row
  }

  /**
   * Change a plan only if its version is still `expectedVersion`. Adds one to
   * `version` and sets `updated_at`.
   * @param id - The plan's id.
   * @param expectedVersion - The version the caller read.
   * @param patch - The columns to change.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when the version was stale.
   */
  async updatePlanVersioned(
    id: string,
    expectedVersion: number,
    patch: PlanPatch,
    tx: DbTransaction
  ): Promise<Plan | undefined> {
    const [row] = await tx
      .update(planModel)
      .set({ ...patch, version: sql`${planModel.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(planModel.id, id), eq(planModel.version, expectedVersion)))
      .returning()
    return row
  }

  /**
   * Every price of a plan, the active ones first and the newest first within
   * each group.
   * @param planId - The plan's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listPrices(planId: string, executor: DbExecutor = db): Promise<PlanPrice[]> {
    return executor
      .select()
      .from(planPriceModel)
      .where(eq(planPriceModel.planId, planId))
      .orderBy(desc(planPriceModel.active), desc(planPriceModel.createdAt), desc(planPriceModel.id))
  }

  /**
   * The prices with these ids, active or retired.
   * @param ids - The price ids.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows found, in no particular order; none for an empty list.
   */
  async findPricesByIds(ids: readonly string[], executor: DbExecutor = db): Promise<PlanPrice[]> {
    if (ids.length === 0) return []
    return executor
      .select()
      .from(planPriceModel)
      .where(inArray(planPriceModel.id, [...ids]))
  }

  /**
   * The active price with no country for a plan, currency and interval.
   * @param planId - The plan's id.
   * @param currency - The currency code.
   * @param interval - `month` or `year`.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when none is active.
   */
  async activePrice(
    planId: string,
    currency: string,
    interval: BillingInterval,
    executor: DbExecutor = db
  ): Promise<PlanPrice | undefined> {
    const [row] = await executor
      .select()
      .from(planPriceModel)
      .where(
        and(
          eq(planPriceModel.planId, planId),
          eq(planPriceModel.currency, currency),
          eq(planPriceModel.interval, interval),
          isNull(planPriceModel.country),
          eq(planPriceModel.active, true)
        )
      )
    return row
  }

  /**
   * Retire the active price that `row` replaces, then insert `row` as the
   * active one. The retired price keeps its `retired_at` time.
   * @param row - The new price.
   * @param tx - The open transaction.
   * @returns The inserted row.
   * @throws {HttpError} 409 when a concurrent price change won the slot.
   */
  async insertPriceRetiringActive(row: NewPlanPrice, tx: DbTransaction): Promise<PlanPrice> {
    await tx
      .update(planPriceModel)
      .set({ active: false, retiredAt: sql`now()` })
      .where(
        and(
          eq(planPriceModel.planId, row.planId),
          eq(planPriceModel.currency, row.currency),
          eq(planPriceModel.interval, row.interval),
          row.country === undefined || row.country === null
            ? isNull(planPriceModel.country)
            : eq(planPriceModel.country, row.country),
          eq(planPriceModel.active, true)
        )
      )
    try {
      const [created] = await tx
        .insert(planPriceModel)
        .values({ ...row, active: true })
        .returning()
      if (created === undefined) throw new HttpError('Insert returned no row', 500)
      return created
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('Another price change is in progress. Try again.', 409)
      }
      throw error
    }
  }

  /**
   * Store the provider's plan id for a price.
   * @param priceId - The price's id.
   * @param provider - The provider.
   * @param mode - The provider mode.
   * @param providerPlanId - The provider's plan id.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when the price does not exist.
   */
  async setProviderPlanId(
    priceId: string,
    provider: BillingProvider,
    mode: BillingProviderMode,
    providerPlanId: string,
    tx: DbTransaction
  ): Promise<PlanPrice | undefined> {
    const [row] = await tx
      .update(planPriceModel)
      .set({ provider, providerMode: mode, providerPlanId })
      .where(eq(planPriceModel.id, priceId))
      .returning()
    return row
  }

  /**
   * Lock a price row `FOR NO KEY UPDATE`, so two callers do not create the
   * provider plan for it twice.
   * @param priceId - The price's id.
   * @param tx - The open transaction.
   * @returns The locked row, or undefined.
   */
  async lockPrice(priceId: string, tx: DbTransaction): Promise<PlanPrice | undefined> {
    const [row] = await tx
      .select()
      .from(planPriceModel)
      .where(eq(planPriceModel.id, priceId))
      .for('no key update')
    return row
  }

  /**
   * The single billing settings row.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row.
   * @throws {HttpError} 500 when the seeded row is missing.
   */
  async getSettings(executor: DbExecutor = db): Promise<BillingSettingsRecord> {
    const [row] = await executor.select().from(billingSettingsModel).limit(1)
    if (row === undefined) throw new HttpError('Billing settings are missing', 500)
    return row
  }

  /**
   * Lock the single billing settings row `FOR NO KEY UPDATE`.
   * @param tx - The open transaction.
   * @returns The locked row.
   * @throws {HttpError} 500 when the seeded row is missing.
   */
  async lockSettings(tx: DbTransaction): Promise<BillingSettingsRecord> {
    const [row] = await tx.select().from(billingSettingsModel).limit(1).for('no key update')
    if (row === undefined) throw new HttpError('Billing settings are missing', 500)
    return row
  }

  /**
   * Change the settings only if their version is still `expectedVersion`.
   * @param expectedVersion - The version the caller read.
   * @param patch - The columns to change.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when the version was stale.
   */
  async updateSettingsVersioned(
    expectedVersion: number,
    patch: BillingSettingsPatch,
    tx: DbTransaction
  ): Promise<BillingSettingsRecord | undefined> {
    const [row] = await tx
      .update(billingSettingsModel)
      .set({
        ...patch,
        version: sql`${billingSettingsModel.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(billingSettingsModel.version, expectedVersion))
      .returning()
    return row
  }

  /**
   * A workspace's grants that are neither revoked nor expired, newest first.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listActiveGrants(tenantId: string, executor: DbExecutor = db): Promise<EntitlementGrant[]> {
    return executor
      .select()
      .from(tenantEntitlementGrantModel)
      .where(
        and(
          eq(tenantEntitlementGrantModel.tenantId, tenantId),
          isNull(tenantEntitlementGrantModel.revokedAt),
          sql`(${tenantEntitlementGrantModel.expiresAt} is null or ${tenantEntitlementGrantModel.expiresAt} > now())`
        )
      )
      .orderBy(desc(tenantEntitlementGrantModel.createdAt), desc(tenantEntitlementGrantModel.id))
  }

  /**
   * Every grant on a workspace, revoked and expired included, newest first.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The rows.
   */
  async listGrants(tenantId: string, executor: DbExecutor = db): Promise<EntitlementGrant[]> {
    return executor
      .select()
      .from(tenantEntitlementGrantModel)
      .where(eq(tenantEntitlementGrantModel.tenantId, tenantId))
      .orderBy(desc(tenantEntitlementGrantModel.createdAt), desc(tenantEntitlementGrantModel.id))
  }

  /**
   * Add a grant.
   * @param row - The grant.
   * @param tx - The open transaction.
   * @returns The inserted row.
   */
  async insertGrant(row: NewEntitlementGrant, tx: DbTransaction): Promise<EntitlementGrant> {
    const [created] = await tx.insert(tenantEntitlementGrantModel).values(row).returning()
    if (created === undefined) throw new HttpError('Insert returned no row', 500)
    return created
  }

  /**
   * One grant of a workspace, locked `FOR NO KEY UPDATE`. A grant of another
   * workspace is never found.
   * @param tenantId - The workspace the grant must belong to.
   * @param grantId - The grant's id.
   * @param tx - The open transaction.
   * @returns The row, or undefined when the workspace has no such grant.
   */
  async lockGrant(
    tenantId: string,
    grantId: string,
    tx: DbTransaction
  ): Promise<EntitlementGrant | undefined> {
    const [row] = await tx
      .select()
      .from(tenantEntitlementGrantModel)
      .where(
        and(
          eq(tenantEntitlementGrantModel.id, grantId),
          eq(tenantEntitlementGrantModel.tenantId, tenantId)
        )
      )
      .for('no key update')
    return row
  }

  /**
   * Revoke a grant that is not yet revoked.
   * @param tenantId - The workspace the grant belongs to.
   * @param grantId - The grant's id.
   * @param by - The staff user revoking it.
   * @param tx - The open transaction.
   * @returns The revoked row, or undefined when none matched.
   */
  async revokeGrant(
    tenantId: string,
    grantId: string,
    by: string,
    tx: DbTransaction
  ): Promise<EntitlementGrant | undefined> {
    const [row] = await tx
      .update(tenantEntitlementGrantModel)
      .set({ revokedAt: sql`now()`, revokedBy: by })
      .where(
        and(
          eq(tenantEntitlementGrantModel.id, grantId),
          eq(tenantEntitlementGrantModel.tenantId, tenantId),
          isNull(tenantEntitlementGrantModel.revokedAt)
        )
      )
      .returning()
    return row
  }

  /**
   * Mark the grants whose expiry has passed as notified, once each.
   * @param now - The current instant.
   * @param tx - The open transaction.
   * @returns The grants this call marked.
   */
  async expireDueGrants(now: Date, tx: DbTransaction): Promise<EntitlementGrant[]> {
    return tx
      .update(tenantEntitlementGrantModel)
      .set({ expiredNotifiedAt: now })
      .where(
        and(
          isNull(tenantEntitlementGrantModel.revokedAt),
          isNull(tenantEntitlementGrantModel.expiredNotifiedAt),
          sql`${tenantEntitlementGrantModel.expiresAt} <= ${now.toISOString()}::timestamptz`
        )
      )
      .returning()
  }
}
