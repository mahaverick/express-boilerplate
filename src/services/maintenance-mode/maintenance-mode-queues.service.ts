/**
 * @file Maintenance mode's hold on the BullMQ queues: `full` pauses every
 * queue `getAllQueues()` (queue.service.ts) returns, anything else resumes
 * them. A pause is BullMQ's queue-wide `Queue.pause()`, a flag in Redis that
 * every replica's Workers obey: running jobs finish, waiting ones stay. Both
 * calls are idempotent, so replicas reconciling at once are harmless.
 *
 * Every replica reconciles on every store reload (`reconcileQueuePause`),
 * which heals a crash between the commit and the pause, and a Redis outage.
 * Each queue is handled on its own and never rejects: the producer
 * connection has no offline queue, so during an outage the calls fail fast
 * and the next reload retries them. A reload's pause waits for the grace
 * (`MAINTENANCE_MODE_PAUSE_GRACE_MS`) so the changing request's notices go out first; a resume is immediate,
 * after removing duplicate scheduler runs queued during the pause.
 *
 * A reconcile acts only while its snapshot is still the store's: before each
 * pause or resume it rereads the store's version, so a change that landed
 * since leaves the queues to that change's own reconcile.
 */
import type { Job, Queue } from 'bullmq'
import { MAINTENANCE_MODE_PAUSE_GRACE_MS } from '@/constants/maintenance-mode.constants'
import { logger } from '@/services/logger.service'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getAllQueues } from '@/services/queue.service'
import type { MaintenanceModeSnapshot, QueuePauseState } from '@/types/maintenance-mode'

/**
 * What a reload does to the queues: pause them, resume them, or leave them as they are.
 */
export type QueuePauseTarget = 'pause' | 'resume' | 'leave'

/**
 * The pending job states a scheduler's next run can sit in.
 */
const PENDING_JOB_TYPES = ['wait', 'delayed', 'prioritized'] as const

/**
 * The queues whose last reconcile failed, so a failure is logged once per streak.
 */
const failingQueues = new Set<string>()

/**
 * The queues whose last duplicate cleanup failed, so that is logged once per streak too.
 */
const failingDedupes = new Set<string>()

/**
 * Forget every failing streak, so the next failure of any queue is logged
 * again. For tests: the two sets live for the process, across test files.
 */
export function resetQueueFailureStreaks(): void {
  failingQueues.clear()
  failingDedupes.clear()
}

/**
 * What a reload does to the queues for one snapshot: `pause` only for
 * `full` whose change is at least `MAINTENANCE_MODE_PAUSE_GRACE_MS` old;
 * `leave` for a younger `full` (the changing request pauses after its
 * notices, and a reload must not undo that) and for an unknown mode;
 * `resume` for every other mode.
 * @param snapshot - The replica's snapshot.
 * @param now - The current instant.
 * @returns The target.
 */
export function queuePauseTarget(snapshot: MaintenanceModeSnapshot, now: Date): QueuePauseTarget {
  if (!snapshot.known) return 'leave'
  if (snapshot.mode !== 'full') return 'resume'
  if (snapshot.changedAt === null) return 'leave'
  const age = now.getTime() - Date.parse(snapshot.changedAt)
  return age >= MAINTENANCE_MODE_PAUSE_GRACE_MS ? 'pause' : 'leave'
}

/**
 * Remove the duplicate pending runs a job scheduler gathered while its
 * queue was paused, before the queue resumes (a scheduler re-upserted
 * during a pause, as each replica boot does, adds one pending run per
 * elapsed interval). Per scheduler, the pending job with id
 * `repeat:<key>:<next>` is kept, or else the one due latest; every other is
 * removed. A scheduler's only pending job is never removed: its chain lives
 * there. A job another replica removed first is skipped.
 * @param queue - A paused queue.
 * @returns How many jobs were removed.
 */
export async function dedupeSchedulerJobs(queue: Queue): Promise<number> {
  const schedulers = await queue.getJobSchedulers(0, -1)
  if (schedulers.length === 0) return 0
  const pending = await queue.getJobs([...PENDING_JOB_TYPES], 0, -1)
  let removed = 0
  for (const scheduler of schedulers) {
    const runs = pending.filter((job) => job.repeatJobKey === scheduler.key)
    if (runs.length <= 1) continue
    const keep = runToKeep(runs, `repeat:${scheduler.key}:${String(scheduler.next)}`)
    for (const job of runs) {
      if (job !== keep && (await tryRemove(queue, job))) removed += 1
    }
  }
  return removed
}

/**
 * The run a scheduler keeps: the one with its next run's id, or else the one due latest.
 * @param runs - The scheduler's pending runs; at least one.
 * @param keepId - `repeat:<key>:<next>`.
 * @returns The run to keep.
 */
function runToKeep(runs: Job[], keepId: string): Job | undefined {
  const byId = runs.find((job) => job.id === keepId)
  if (byId) return byId
  let latest: Job | undefined
  for (const job of runs) {
    if (latest === undefined || dueAt(job) > dueAt(latest)) latest = job
  }
  return latest
}

/**
 * When a pending job is due.
 * @param job - The job.
 * @returns Its timestamp plus its delay, in ms.
 */
function dueAt(job: Job): number {
  return job.timestamp + (job.opts.delay ?? 0)
}

/**
 * Remove one duplicate run, treating one already gone as not removed here.
 * @param queue - Its queue.
 * @param job - The run.
 * @returns True when this call removed it.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- `try…` names an attempt; the boolean says whether this call removed the job
async function tryRemove(queue: Queue, job: Job): Promise<boolean> {
  try {
    await job.remove()
    return true
  } catch (error) {
    // BullMQ reports a job another replica already removed the same way as a locked one.
    if (job.id !== undefined && (await queue.getJobState(job.id)) !== 'unknown') {
      logger.warn('A duplicate scheduler job could not be removed', {
        queue: queue.name,
        jobId: job.id,
        error,
      })
    }
    return false
  }
}

/**
 * Remove a paused queue's duplicate scheduler runs before it resumes. A
 * failure is logged once per streak and never stops the resume: a few
 * duplicate runs are better than a queue left paused. Never rejects.
 * @param queue - A paused queue.
 */
async function dedupeBeforeResume(queue: Queue): Promise<void> {
  try {
    await dedupeSchedulerJobs(queue)
    failingDedupes.delete(queue.name)
  } catch (error) {
    if (!failingDedupes.has(queue.name)) {
      logger.warn(
        'Duplicate scheduler runs could not be removed before the queue resumed; duplicate runs may follow',
        {
          queue: queue.name,
          error,
        }
      )
    }
    failingDedupes.add(queue.name)
  }
}

/**
 * Bring one queue to the target. Never rejects.
 * @param queue - The queue.
 * @param target - Pause or resume.
 * @param version - The store version the target was decided for; the queue is left alone once the store holds another. Omit to act whatever the store holds.
 */
async function applyTarget(
  queue: Queue,
  target: 'pause' | 'resume',
  version?: number
): Promise<void> {
  const isSuperseded = (): boolean =>
    version !== undefined && getMaintenanceMode().version !== version
  try {
    const isPaused = await queue.isPaused()
    if (target === 'pause' && !isPaused && !isSuperseded()) await queue.pause()
    if (target === 'resume' && isPaused && !isSuperseded()) {
      await dedupeBeforeResume(queue)
      if (!isSuperseded()) await queue.resume()
    }
    failingQueues.delete(queue.name)
  } catch (error) {
    if (!failingQueues.has(queue.name)) {
      logger.warn(
        target === 'resume'
          ? "A queue's pause state could not be checked or resumed; if it is paused, a later reload retries the resume"
          : 'A queue could not be paused for maintenance mode; the next reload retries',
        { queue: queue.name, error }
      )
    }
    failingQueues.add(queue.name)
  }
}

/**
 * Bring every queue to one target. Never rejects.
 * @param target - Pause or resume.
 * @param version - The store version the target was decided for, if it is to be rechecked.
 * @returns Resolves once every queue has been tried.
 */
async function applyToAllQueues(target: 'pause' | 'resume', version?: number): Promise<void> {
  let queues: Queue[]
  try {
    queues = getAllQueues()
  } catch (error) {
    // Only during shutdown: the queue module refuses new connections.
    logger.warn('Maintenance mode could not reach the queues', { error })
    return
  }
  await Promise.all(queues.map((queue) => applyTarget(queue, target, version)))
}

/**
 * Pause or resume every queue now, whatever the grace: what the changing
 * request does once its notices are out (pause) or when leaving `full`
 * (resume, after removing duplicate scheduler runs). Never rejects.
 * @param shouldPause - True to pause, false to resume.
 * @returns Resolves once every queue has been tried.
 */
export async function setAllQueuesPaused(shouldPause: boolean): Promise<void> {
  await applyToAllQueues(shouldPause ? 'pause' : 'resume')
}

/**
 * Bring every queue to what one snapshot asks (`queuePauseTarget`). Called
 * after every store reload. Never rejects.
 * @param snapshot - The replica's snapshot.
 * @param now - The current instant; injectable for tests.
 * @returns Resolves once every queue has been tried.
 */
export async function reconcileQueuePause(
  snapshot: MaintenanceModeSnapshot,
  now: Date = new Date()
): Promise<void> {
  const target = queuePauseTarget(snapshot, now)
  if (target === 'leave') return
  await applyToAllQueues(target, snapshot.version)
}

/**
 * Each queue's pause state and running-job count, read from Redis, which
 * every replica sees alike.
 * @returns One entry per queue, in registry order; a field Redis could not answer is null.
 */
export async function getQueuePauseStates(): Promise<QueuePauseState[]> {
  let queues: Queue[]
  try {
    queues = getAllQueues()
  } catch {
    return []
  }
  return Promise.all(
    queues.map(async (queue) => {
      const [paused, active] = await Promise.allSettled([queue.isPaused(), queue.getActiveCount()])
      return {
        name: queue.name,
        // eslint-disable-next-line unicorn/no-null -- the contract is null for "Redis did not answer"
        paused: paused.status === 'fulfilled' ? paused.value : null,
        // eslint-disable-next-line unicorn/no-null -- as above
        active: active.status === 'fulfilled' ? active.value : null,
      }
    })
  )
}
