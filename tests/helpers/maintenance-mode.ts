/**
 * @file Writes to this worker's `maintenance_mode_state` row for tests. Every
 * write increments `version`, because a store ignores a row whose version is
 * not above its copy's: a reset that wrote version 0 would be ignored by a
 * store that had already applied a later one.
 */
import type { MaintenanceMode } from '@/constants/maintenance-mode.constants'
import { sql } from '@/services/database.service'

/**
 * Store a mode directly, as a committed change would, without auditing,
 * publishing or notifying.
 * @param mode - The mode.
 * @param options - The rest of the row.
 * @param options.message - The customer message; defaults to `Back soon.` unless `mode` is `off`.
 * @param options.changedAt - When it changed; defaults to now.
 * @returns The stored version.
 */
export async function storeMaintenanceMode(
  mode: MaintenanceMode,
  options: { message?: string; changedAt?: Date } = {}
): Promise<number> {
  const message = mode === 'off' ? undefined : (options.message ?? 'Back soon.')
  const changedAt = (options.changedAt ?? new Date()).toISOString()
  const [row] =
    mode === 'off'
      ? await sql<{ version: number }[]>`
        update maintenance_mode_state
        set mode = 'off', message = null, reason = null, changed_by = null,
            changed_at = ${changedAt}::timestamptz, version = version + 1
        where id = 1
        returning version`
      : await sql<{ version: number }[]>`
        update maintenance_mode_state
        set mode = ${mode}, message = ${message ?? ''}, reason = null, changed_by = null,
            changed_at = ${changedAt}::timestamptz, version = version + 1
        where id = 1
        returning version`
  if (!row) throw new Error('setup: migration 0024 seeds the maintenance_mode_state row')
  return row.version
}

/**
 * Put the row back to `off` with a new version, so every store that reloads applies it.
 * @returns The stored version.
 */
export async function resetMaintenanceMode(): Promise<number> {
  return storeMaintenanceMode('off')
}
