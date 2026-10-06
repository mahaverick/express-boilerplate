/**
 * @file Maintenance mode as the rest of the app asks about it: whether a
 * user may sign in now, the public status and the staff status section.
 * They read this replica's in-memory mode, never Postgres.
 */
import { MAINTENANCE_MODE_CODE } from '@/constants/maintenance-mode.constants'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { hasPendingNotices } from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { getQueuePauseStates } from '@/services/maintenance-mode/maintenance-mode-queues.service'
import {
  getMaintenanceMode,
  getMaintenanceModeReloadError,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getPlatformMembership } from '@/services/platform.service'
import type { MaintenanceModeStatus, PublicMaintenanceStatus } from '@/types/maintenance-mode'

/**
 * Refuse a sign-in in `full` unless the user is staff (holds any platform
 * role). Called by password login and the Google callback after the user is
 * identified and before a session is created; in any other mode it reads nothing.
 * @param userId - The user signing in.
 * @returns Resolves when the sign-in may go ahead.
 * @throws {MaintenanceModeError} 503 `MAINTENANCE_MODE` for a non-staff user in `full`.
 */
export async function assertSignInAllowed(userId: string): Promise<void> {
  const snapshot = getMaintenanceMode()
  if (snapshot.mode !== 'full') return
  const platformRole = await getPlatformMembership(userId)
  if (platformRole === null) throw new MaintenanceModeError(MAINTENANCE_MODE_CODE, snapshot)
}

/**
 * The public status: the mode, the customer message and when it began.
 * Never the reason, the actor or the version.
 * @returns The status, from memory.
 */
export function getPublicMaintenanceStatus(): PublicMaintenanceStatus {
  const { mode, message, since } = getMaintenanceMode()
  return { mode, message, since }
}

/**
 * The maintenance section of the staff system status, as this replica sees
 * it: the mode, whether it is known, each queue's pause state, whether the
 * last change's notices are still pending, and the last reload failure.
 * @returns The section; never rejects (a Redis failure shows as null queue fields and no pending notices).
 */
export async function getMaintenanceModeStatus(): Promise<MaintenanceModeStatus> {
  const snapshot = getMaintenanceMode()
  const [queues, noticesPending] = await Promise.all([getQueuePauseStates(), hasPendingNotices()])
  return {
    mode: snapshot.mode,
    since: snapshot.since,
    known: snapshot.known,
    queuesPaused: queues.length > 0 && queues.every((queue) => queue.paused === true),
    queues,
    noticesPending,
    lastReloadError: getMaintenanceModeReloadError(),
  }
}
