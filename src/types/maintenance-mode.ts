/**
 * @file The maintenance-mode shapes the store, the gate, the services and
 * the HTTP layer share.
 */
import type { MaintenanceMode } from '@/constants/maintenance-mode.constants'

/**
 * One replica's in-memory copy of the stored mode.
 */
export interface MaintenanceModeSnapshot {
  mode: MaintenanceMode
  /**
   * The customer message; null while `off`.
   */
  message: string | null
  /**
   * When the current mode began (ISO 8601); null while `off`.
   */
  since: string | null
  /**
   * When the row last changed (ISO 8601), whatever the mode; null until the
   * first successful read. Kept apart from `since`, which is null while `off`.
   */
  changedAt: string | null
  version: number
  /**
   * False until this replica has read the row once: it then serves `off`.
   */
  known: boolean
}
