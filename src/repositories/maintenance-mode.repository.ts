/**
 * @file Query access to `maintenance_mode_state`, the single row migration
 * 0024 seeds, and to the staff a change names or notifies. A change is a
 * compare-and-set on `version`, so of two concurrent changes made against
 * one version exactly one lands.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { MaintenanceMode } from '@/constants/maintenance-mode.constants'
import {
  maintenanceModeState,
  type MaintenanceModeStateRow,
} from '@/database/models/maintenance-mode-state.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel, type User } from '@/database/models/user.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * The single row's id (`maintenance_mode_state_single_row_check`).
 */
const ROW_ID = 1

/**
 * What one change writes; `version` and `changed_at` are set by the update itself (`changed_at` only when the mode changes).
 * When the mode stays the same the stored `changed_by` is kept, and so is the stored `reason` unless `reason` is given (`null` clears it).
 */
export interface MaintenanceModeChange {
  mode: MaintenanceMode
  message: string | null
  /**
   * The reason to store; `null` stores none. `undefined` keeps the stored
   * reason on a save that keeps the mode, and stores none on a mode change.
   */
  reason?: string | null | undefined
  changedBy: string
}

/**
 * Read the stored mode.
 * @param executor - Where to run the query. Defaults to the pool.
 * @returns The row.
 * @throws {Error} When the row is missing (migration 0024 inserts it) or the query fails.
 */
export async function readMaintenanceModeState(
  executor: DbExecutor = db
): Promise<MaintenanceModeStateRow> {
  const [row] = await executor
    .select()
    .from(maintenanceModeState)
    .where(eq(maintenanceModeState.id, ROW_ID))
  if (!row) throw new Error('The maintenance_mode_state row is missing')
  return row
}

/**
 * Read the stored mode and hold the row `FOR NO KEY UPDATE` until the
 * transaction ends, so a concurrent change waits and then sees this one's version.
 * @param tx - The change's transaction.
 * @returns The row.
 * @throws {Error} When the row is missing or the query fails.
 */
export async function lockMaintenanceModeState(
  tx: DbTransaction
): Promise<MaintenanceModeStateRow> {
  const [row] = await tx
    .select()
    .from(maintenanceModeState)
    .where(eq(maintenanceModeState.id, ROW_ID))
    .for('no key update')
  if (!row) throw new Error('The maintenance_mode_state row is missing')
  return row
}

/**
 * A staff member as a maintenance-mode change names them.
 */
export type MaintenanceModeStaff = Pick<User, 'id' | 'email' | 'firstName' | 'lastName'>

/**
 * The live, active platform owners and admins other than `exceptUserId`:
 * who a maintenance-mode notice goes to.
 * @param exceptUserId - The staff member who made the change.
 * @param executor - Where to run the query. Defaults to the pool.
 * @returns Their ids, addresses and names, in no guaranteed order.
 */
export async function listMaintenanceModeNoticeRecipients(
  exceptUserId: string,
  executor: DbExecutor = db
): Promise<MaintenanceModeStaff[]> {
  return executor
    .select({
      id: userModel.id,
      email: userModel.email,
      firstName: userModel.firstName,
      lastName: userModel.lastName,
    })
    .from(userMembershipModel)
    .innerJoin(tenantModel, eq(userMembershipModel.tenantId, tenantModel.id))
    .innerJoin(userModel, eq(userMembershipModel.userId, userModel.id))
    .where(
      and(
        eq(tenantModel.isPlatform, true),
        inArray(userMembershipModel.role, ['owner', 'admin']),
        isNull(userModel.deletedAt),
        eq(userModel.active, true),
        ne(userModel.id, exceptUserId)
      )
    )
}

/**
 * The user a change names, whatever their state now.
 * @param userId - The `changed_by` id.
 * @param executor - Where to run the query. Defaults to the pool.
 * @returns Their id, address and names, or undefined when the row is gone.
 */
export async function findMaintenanceModeStaff(
  userId: string,
  executor: DbExecutor = db
): Promise<MaintenanceModeStaff | undefined> {
  const [row] = await executor
    .select({
      id: userModel.id,
      email: userModel.email,
      firstName: userModel.firstName,
      lastName: userModel.lastName,
    })
    .from(userModel)
    .where(eq(userModel.id, userId))
  return row
}

/**
 * Write a change only if the stored version is still `expectedVersion`,
 * incrementing it. `changed_at` is the time the mode last changed: it takes
 * the transaction's time only when the mode differs from the stored one, so
 * a message edit or any other save that keeps the mode leaves it alone. Such
 * a save also keeps `changed_by` (who set the mode) and keeps the stored
 * `reason` unless the change carries one (`null` clears it); a mode change
 * always writes both.
 * @param change - The new mode, message, reason and actor.
 * @param expectedVersion - The version the caller read.
 * @param executor - The change's transaction.
 * @returns The updated row, or undefined when the version no longer matches.
 */
export async function updateMaintenanceModeStateIfVersion(
  change: MaintenanceModeChange,
  expectedVersion: number,
  executor: DbExecutor
): Promise<MaintenanceModeStateRow | undefined> {
  const [row] = await executor
    .update(maintenanceModeState)
    .set({
      mode: change.mode,
      message: change.message,
      reason:
        change.reason === undefined
          ? sql`case when ${maintenanceModeState.mode} = ${change.mode} then ${maintenanceModeState.reason} else null end`
          : sql`${change.reason}::text`,
      changedBy: sql`case when ${maintenanceModeState.mode} = ${change.mode} then ${maintenanceModeState.changedBy} else ${change.changedBy}::varchar end`,
      changedAt: sql`case when ${maintenanceModeState.mode} = ${change.mode} then ${maintenanceModeState.changedAt} else now() end`,
      version: sql`${maintenanceModeState.version} + 1`,
    })
    .where(
      and(eq(maintenanceModeState.id, ROW_ID), eq(maintenanceModeState.version, expectedVersion))
    )
    .returning()
  return row
}
