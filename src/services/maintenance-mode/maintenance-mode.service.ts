/**
 * @file Maintenance mode as the rest of the app asks about it: whether a
 * user may sign in now, the public status and the staff status section,
 * which read this replica's in-memory mode; and the staff view and change
 * behind `/platform/maintenance-mode`, which read and write Postgres.
 *
 * A change commits the row and its audit entry in one transaction, then
 * publishes the reload, queues the notices, and, entering `full`, waits for
 * them before pausing every queue; leaving `full` resumes them. Messages and
 * reasons are stored as given and never logged.
 */
import type { Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import {
  CONFIRMATION_MISMATCH_CODE,
  MAINTENANCE_ACTOR_PLACEHOLDER,
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_MODE_CONFLICT_CODE,
  type MaintenanceMode,
} from '@/constants/maintenance-mode.constants'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { addNotificationJob, type NotificationJobData } from '@/jobs/notification.job'
import {
  findMaintenanceModeStaff,
  listMaintenanceModeNoticeRecipients,
  lockMaintenanceModeState,
  readMaintenanceModeState,
  updateMaintenanceModeStateIfVersion,
  type MaintenanceModeStaff,
} from '@/repositories/maintenance-mode.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import {
  hasPendingNotices,
  noticeWaitBudgetMs,
  rememberNoticeJobs,
  waitForNoticeJobs,
} from '@/services/maintenance-mode/maintenance-mode-notices.service'
import {
  getQueuePauseStates,
  setAllQueuesPaused,
} from '@/services/maintenance-mode/maintenance-mode-queues.service'
import {
  getMaintenanceMode,
  getMaintenanceModeReloadError,
  publishMaintenanceModeChange,
  reloadMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { assertStillPlatformRole, getPlatformMembership } from '@/services/platform.service'
import { MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY } from '@/templates/email/maintenance-mode-changed.template'
import type { Actor } from '@/types/actor'
import type {
  MaintenanceModeStatus,
  PlatformMaintenanceModeView,
  PublicMaintenanceStatus,
} from '@/types/maintenance-mode'
import type { ChangeMaintenanceModeBody } from '@/validators/maintenance-mode.validators'
import { emailJobIdFor } from '@/workers/notification.worker'

const tenantRepository = new TenantRepository()

/**
 * The kinds of change, by the stored mode and the new one.
 */
type ChangeKind = 'switch_on' | 'escalate' | 'switch_off' | 'de_escalate' | 'message'

/**
 * Each mode as words, for the notices.
 */
const MODE_WORDS: Readonly<Record<MaintenanceMode, string>> = {
  off: 'off',
  read_only: 'read-only',
  full: 'full',
}

/**
 * The changes every other owner and admin is told about; a message edit or
 * a de-escalation is not.
 */
const NOTICED_KINDS: ReadonlySet<ChangeKind> = new Set(['switch_on', 'escalate', 'switch_off'])

/**
 * What a notice says when the change gave no reason.
 */
const NO_REASON = 'No reason given.'

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

/**
 * The kind of change from one mode to another.
 * @param from - The stored mode.
 * @param to - The new mode.
 * @returns The kind.
 */
function changeKindOf(from: MaintenanceMode, to: MaintenanceMode): ChangeKind {
  if (from === to) return 'message'
  if (from === 'off') return 'switch_on'
  if (to === 'off') return 'switch_off'
  return to === 'full' ? 'escalate' : 'de_escalate'
}

/**
 * A staff member's display name: their names, or `MAINTENANCE_ACTOR_PLACEHOLDER` when they have none:
 * never their address, which would reach other staff's notices and the notice jobs' Redis data.
 * @param staff - The staff member.
 * @returns The name.
 */
function nameOf(staff: MaintenanceModeStaff): string {
  const name = [staff.firstName, staff.lastName].filter(Boolean).join(' ')
  return name === '' ? MAINTENANCE_ACTOR_PLACEHOLDER : name
}

/**
 * Refuse a change the stored mode does not allow: a mode that is on needs
 * a message; switching on or escalating also needs a reason and `confirm`
 * equal to `APP_ENV`.
 * @param kind - The kind of change.
 * @param body - The validated body.
 * @throws {HttpError} 400 `Validation failed` for a missing message or reason; 400 `CONFIRMATION_MISMATCH` for a wrong or missing confirm.
 */
function assertChangeAllowed(kind: ChangeKind, body: ChangeMaintenanceModeBody): void {
  if (body.mode !== 'off' && body.message === undefined) {
    throw new HttpError('Validation failed', 400, undefined, {
      message: ['message is required while maintenance mode is on.'],
    })
  }
  if (kind !== 'switch_on' && kind !== 'escalate') return
  if (body.reason === undefined) {
    throw new HttpError('Validation failed', 400, undefined, {
      reason: ['reason is required to switch maintenance mode on or escalate it.'],
    })
  }
  if (body.confirm !== getEnv().APP_ENV) {
    throw new HttpError('Type the environment name to confirm.', 400, CONFIRMATION_MISMATCH_CODE)
  }
}

/**
 * The staff view of the stored mode, read from Postgres, with each queue's
 * pause state and the environment name a switch-on must confirm.
 * @returns The view.
 */
export async function getPlatformMaintenanceMode(): Promise<PlatformMaintenanceModeView> {
  const row = await readMaintenanceModeState()
  const [changedBy, queues] = await Promise.all([
    row.changedBy === null ? undefined : findMaintenanceModeStaff(row.changedBy),
    getQueuePauseStates(),
  ])
  const isOff = row.mode === 'off'
  return {
    mode: row.mode,
    // eslint-disable-next-line unicorn/no-null -- the view's contract uses null for "none"
    message: isOff ? null : row.message,
    reason: row.reason,
    // eslint-disable-next-line unicorn/no-null -- as above
    since: isOff ? null : row.changedAt.toISOString(),
    // eslint-disable-next-line unicorn/no-null -- as above
    changedBy: changedBy ? { id: changedBy.id, name: nameOf(changedBy) } : null,
    version: row.version,
    queues,
    environment: getEnv().APP_ENV,
  }
}

/**
 * What a committed change hands to the steps after its transaction.
 */
interface CommittedChange {
  kind: ChangeKind
  from: MaintenanceMode
  to: MaintenanceMode
  reason: string | null
  changedAt: Date
  version: number
}

/**
 * Queue one in-app notice and email to every other platform owner and admin,
 * and record the jobs for the status section. A failed enqueue is logged and
 * skipped: the change is already committed.
 * @param actor - The staff member who made the change.
 * @param change - The committed change.
 * @returns The notification jobs queued.
 */
async function queueNotices(actor: Actor, change: CommittedChange): Promise<Job[]> {
  const [recipients, actorRow] = await Promise.all([
    listMaintenanceModeNoticeRecipients(actor.userId),
    findMaintenanceModeStaff(actor.userId),
  ])
  const actorName = actorRow ? nameOf(actorRow) : MAINTENANCE_ACTOR_PLACEHOLDER
  const appName = getEnv().APP_NAME
  const mode = MODE_WORDS[change.to]
  const changedAt = change.changedAt.toISOString()
  const reason = change.reason ?? NO_REASON
  const jobs: Job[] = []
  for (const recipient of recipients) {
    const data: NotificationJobData = {
      userId: recipient.id,
      type: 'maintenance_mode_changed',
      title: `Maintenance mode is now ${mode}`,
      body: `${actorName} set maintenance mode to ${mode} at ${changedAt}. Reason: ${reason}`,
      metadata: {
        templateKey: MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY,
        from: change.from,
        to: change.to,
      },
      email: {
        to: recipient.email,
        templateKey: MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY,
        variables: {
          firstName: recipient.firstName ?? 'there',
          appName,
          mode,
          actorName,
          reason,
          changedAt,
        },
      },
    }
    try {
      jobs.push(await addNotificationJob(data))
    } catch (error) {
      logger.error('A maintenance-mode notice could not be queued', {
        error,
        recipientId: recipient.id,
      })
    }
  }
  return jobs
}

/**
 * Change the maintenance mode, as the platform owner. In order: one
 * transaction re-checks the owner role under lock, locks the row, checks
 * `expectedVersion` (409), answers a no-op (same mode and message) with the
 * current state and writes nothing, checks the change's rules, updates the
 * row (`version + 1`) and writes the audit entry. Then it publishes the
 * reload and rereads this replica's copy, queues notices for a switch-on,
 * an escalation or a switch-off, and entering `full` waits for them under
 * one shared deadline before pausing every queue (a timeout or Redis error
 * is logged and the pause goes ahead); leaving `full` resumes them.
 * @param actor - The platform owner.
 * @param body - The validated body.
 * @returns The view after the change.
 * @throws {HttpError} 409 `MAINTENANCE_MODE_CONFLICT` for a stale version; 400 for a missing message or reason, or a wrong confirm; 404 when the actor is no longer an owner.
 */
export async function changeMaintenanceMode(
  actor: Actor,
  body: ChangeMaintenanceModeBody
): Promise<PlatformMaintenanceModeView> {
  const committed = await withTransaction(async (tx): Promise<CommittedChange | undefined> => {
    await assertStillPlatformRole(actor, 'owner', tx)
    const current = await lockMaintenanceModeState(tx)
    if (current.version !== body.expectedVersion) {
      throw new HttpError(
        'Maintenance mode changed since it was loaded.',
        409,
        MAINTENANCE_MODE_CONFLICT_CODE
      )
    }
    const kind = changeKindOf(current.mode, body.mode)
    // eslint-disable-next-line unicorn/no-null -- the column is null while off
    const message = body.mode === 'off' ? null : (body.message ?? null)
    if (kind === 'message' && (body.mode === 'off' || message === current.message)) return undefined
    assertChangeAllowed(kind, body)
    // eslint-disable-next-line unicorn/no-null -- the column is null when no reason was given
    const reason = body.reason ?? null
    const updated = await updateMaintenanceModeStateIfVersion(
      { mode: body.mode, message, reason, changedBy: actor.userId },
      body.expectedVersion,
      tx
    )
    if (!updated) {
      throw new HttpError(
        'Maintenance mode changed since it was loaded.',
        409,
        MAINTENANCE_MODE_CONFLICT_CODE
      )
    }
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (!platform) throw new HttpError('The platform tenant is missing', 500)
    await record(
      {
        action: 'platform.maintenance_mode_changed',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: platform.id,
        metadata: {
          from: current.mode,
          to: body.mode,
          reason,
          // Compared as text: a mode that is off has no message, whatever the column holds.
          messageChanged:
            (message ?? '') !== (current.mode === 'off' ? '' : (current.message ?? '')),
        },
      },
      tx
    )
    return {
      kind,
      from: current.mode,
      to: body.mode,
      reason,
      changedAt: updated.changedAt,
      version: updated.version,
    }
  })
  if (committed === undefined) return getPlatformMaintenanceMode()

  await publishMaintenanceModeChange()
  await reloadMaintenanceMode()
  const isNoticed = NOTICED_KINDS.has(committed.kind)
  const jobs = isNoticed ? await queueNotices(actor, committed) : []
  if (isNoticed) {
    await rememberNoticeJobs({
      notification: jobs.flatMap((job) => (job.id === undefined ? [] : [job.id])),
      email: jobs.flatMap((job) => (job.id === undefined ? [] : [emailJobIdFor(job)])),
    })
  }
  if (committed.to === 'full' && committed.from !== 'full') {
    const outcome = await waitForNoticeJobs(
      { notification: jobs },
      noticeWaitBudgetMs(committed.changedAt)
    )
    if (outcome !== 'done') {
      logger.warn('Maintenance-mode notices were not all sent before the queues paused', {
        outcome,
      })
    }
    // A later change may have left `full` during the wait; it owns the queues now.
    if (getMaintenanceMode().version === committed.version) await setAllQueuesPaused(true)
  } else if (committed.from === 'full' && committed.to !== 'full') {
    await setAllQueuesPaused(false)
  }
  return getPlatformMaintenanceMode()
}
