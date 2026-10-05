/**
 * @file The system status behind `GET /platform/system/status`: the running
 * release, error tracking's health, summed across every API and worker
 * process, and the feature flags' snapshot and counts. It reads no per-user
 * data, so it is not audited. An open object: each later section is one more
 * key.
 */
import { getEnv } from '@/configs/env.config'
import {
  getErrorTrackingStatus,
  type ErrorTrackingStatus,
} from '@/services/errors/error-counters.service'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import type { FlagsStatus } from '@/types/flags'

/**
 * The system status.
 */
export interface SystemStatus {
  /**
   * The running image's git sha (`APP_VERSION`), `dev` outside an image.
   */
  release: string
  errorTracking: ErrorTrackingStatus
  flags: FlagsStatus
}

/**
 * The system status.
 * @returns The release, error tracking's counters and the flags' status; never rejects.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const [errorTracking, flags] = await Promise.all([getErrorTrackingStatus(), getFlagsStatus()])
  return { release: getEnv().APP_VERSION, errorTracking, flags }
}
