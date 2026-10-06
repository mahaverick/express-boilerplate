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

/**
 * What `GET /api/v1/status/maintenance` answers, to anyone.
 */
export interface PublicMaintenanceStatus {
  mode: MaintenanceMode
  message: string | null
  since: string | null
}

/**
 * One queue's pause state for Apex; `paused` and `active` are null when
 * Redis could not be asked.
 */
export interface QueuePauseState {
  name: string
  paused: boolean | null
  active: number | null
}

/**
 * The maintenance section of the staff system status.
 */
export interface MaintenanceModeStatus {
  mode: MaintenanceMode
  since: string | null
  /**
   * False while this replica has never read the row: Apex shows "unknown".
   */
  known: boolean
  /**
   * True only when every queue answered and is paused.
   */
  queuesPaused: boolean
  queues: QueuePauseState[]
  /**
   * True while a notice job of the last change has not finished.
   */
  noticesPending: boolean
  /**
   * The label of this replica's last failed reload, or null.
   */
  lastReloadError: string | null
}
