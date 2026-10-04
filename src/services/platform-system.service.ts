/**
 * @file The system status behind `GET /platform/system/status`: the running
 * release and error tracking's health, summed across every API and worker
 * process. It reads no per-user data, so it is not audited. An open object:
 * each later section is one more key.
 */
import { getEnv } from '@/configs/env.config'
import {
  getErrorTrackingStatus,
  type ErrorTrackingStatus,
} from '@/services/errors/error-counters.service'

/**
 * The system status.
 */
export interface SystemStatus {
  /**
   * The running image's git sha (`APP_VERSION`), `dev` outside an image.
   */
  release: string
  errorTracking: ErrorTrackingStatus
}

/**
 * The system status.
 * @returns The release and error tracking's counters; never rejects.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  return { release: getEnv().APP_VERSION, errorTracking: await getErrorTrackingStatus() }
}
