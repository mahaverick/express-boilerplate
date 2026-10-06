/**
 * @file Query access to `maintenance_mode_state`, the single row migration
 * 0024 seeds. A change is a compare-and-set on `version`, so of two
 * concurrent changes made against one version exactly one lands.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { MaintenanceMode } from '@/constants/maintenance-mode.constants'
import {
  maintenanceModeState,
  type MaintenanceModeStateRow,
} from '@/database/models/maintenance-mode-state.model'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * The single row's id (`maintenance_mode_state_single_row_check`).
 */
const ROW_ID = 1

/**
 * What one change writes; `version` and `changed_at` are set by the update itself.
 */
export interface MaintenanceModeChange {
  mode: MaintenanceMode
  message: string | null
  reason: string | null
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
 * Write a change only if the stored version is still `expectedVersion`,
 * incrementing it and stamping `changed_at` with the transaction's time.
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
      reason: change.reason,
      changedBy: change.changedBy,
      changedAt: sql`now()`,
      version: sql`${maintenanceModeState.version} + 1`,
    })
    .where(
      and(eq(maintenanceModeState.id, ROW_ID), eq(maintenanceModeState.version, expectedVersion))
    )
    .returning()
  return row
}
