// src/repositories/tenant-settings.repository.ts
//
// Deliberately does NOT extend BaseRepository — same reasoning
// notification-preference.repository.ts gives for itself: no soft-delete
// concept (`tenant_settings` has no `deletedAt` — see tenant.model.ts's
// own header comment for why), and nothing to translate a 23505 into
// (`tenant_id` is this table's own primary key, so there is no separate
// unique constraint a write here could violate). A plain class with
// exactly the operations a settings row needs.
import { eq, sql } from 'drizzle-orm'
import {
  tenantSettingsModel,
  type NewTenantSettings,
  type TenantSettings,
} from '@/database/models/tenant.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The columns `TenantSettingsRepository.update` may change. Excludes
 * `tenantId` (the row's own primary key — never reassigned to a different
 * tenant) and `updatedAt` (bumped automatically by `update` itself, the
 * same "no call site can forget" reasoning `BaseRepository.touched`
 * documents for every other table).
 */
export type UpdateTenantSettingsInput = Partial<Omit<NewTenantSettings, 'tenantId' | 'updatedAt'>>

/**
 * Query access to the `tenant_settings` table: read and update the one
 * settings row a tenant has. There is no `create` here — the row is
 * created exactly once, atomically alongside its tenant, by
 * `TenantRepository.create` (tenant.repository.ts).
 */
export class TenantSettingsRepository {
  /**
   * Find the settings row for one tenant.
   * @param tenantId - The tenant whose settings to fetch.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when no such tenant exists (every tenant that does exist has exactly one settings row, created atomically alongside it).
   */
  async findByTenantId(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<TenantSettings | undefined> {
    const [row] = await executor
      .select()
      .from(tenantSettingsModel)
      .where(eq(tenantSettingsModel.tenantId, tenantId))
    return row
  }

  /**
   * Find the settings row for one tenant and lock it (`SELECT … FOR NO KEY
   * UPDATE`) for the rest of the transaction. Nothing deletes a settings row
   * or changes its key. Lock order: after the access locks
   * `lockTenantAccess` takes (tenant-access.service.ts).
   * @param tenantId - The tenant whose settings to lock.
   * @param executor - The transaction to hold the lock in. Required: on the pool, the lock would release as soon as the statement finished.
   * @returns The locked row, or undefined when no such tenant exists.
   */
  async lockByTenantId(
    tenantId: string,
    executor: DbTransaction
  ): Promise<TenantSettings | undefined> {
    const [row] = await executor
      .select()
      .from(tenantSettingsModel)
      .where(eq(tenantSettingsModel.tenantId, tenantId))
      .for('no key update')
    return row
  }

  /**
   * Update one tenant's settings.
   * @param tenantId - The tenant whose settings to update.
   * @param values - The columns to change.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no settings row exists for this tenant id.
   */
  async update(
    tenantId: string,
    values: UpdateTenantSettingsInput,
    executor: DbExecutor = db
  ): Promise<TenantSettings | undefined> {
    // `sql\`now()\`` — evaluated by Postgres, not read from the
    // application's clock — same reasoning as `BaseRepository.touched`
    // (base.repository.ts).
    const [row] = await executor
      .update(tenantSettingsModel)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(tenantSettingsModel.tenantId, tenantId))
      .returning()
    return row
  }
}
