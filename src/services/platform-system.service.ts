/**
 * @file The system status behind `GET /platform/system/status`: the running
 * release, error tracking's health, summed across every API and worker
 * process, the feature flags' snapshot and counts, and maintenance mode as
 * the answering replica sees it. It reads no per-user data, so it is not
 * audited. An open object: each section is one key.
 */
import { getEnv } from '@/configs/env.config'
import {
  getErrorTrackingStatus,
  type ErrorTrackingStatus,
} from '@/services/errors/error-counters.service'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import { getMaintenanceModeStatus } from '@/services/maintenance-mode/maintenance-mode.service'
import type { FlagsStatus } from '@/types/flags'
import type { MaintenanceModeStatus } from '@/types/maintenance-mode'

/**
 * The body of `GET /platform/system/status`: one key per section.
 */
export interface SystemStatus {
  /**
   * The running image's git sha (`APP_VERSION`), `dev` outside an image.
   */
  release: string
  errorTracking: ErrorTrackingStatus
  flags: FlagsStatus
  /**
   * Maintenance mode; optional in the contract, so a client also accepts an
   * API without the section; always set here.
   */
  maintenance?: MaintenanceModeStatus
}

/**
 * Gather every section of the system status in parallel.
 * @returns The release, error tracking's counters, the flags' status and maintenance mode; never rejects.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const [errorTracking, flags, maintenance] = await Promise.all([
    getErrorTrackingStatus(),
    getFlagsStatus(),
    getMaintenanceModeStatus(),
  ])
  return { release: getEnv().APP_VERSION, errorTracking, flags, maintenance }
}
