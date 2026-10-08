/**
 * @file Queue pause and resume against real BullMQ under this worker's
 * prefix: reconciliation pauses every registry queue for an old `full`,
 * heals a queue a missed pause left running, leaves paused queues alone
 * inside the grace, resumes on leaving `full`, and survives one queue
 * failing; the per-queue states and the status section; and
 * `dedupeSchedulerJobs` cutting a paused scheduler's duplicate runs to one.
 */
import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/services/logger.service'
import {
  dedupeSchedulerJobs,
  getQueuePauseStates,
  reconcileQueuePause,
  resetQueueFailureStreaks,
  setAllQueuesPaused,
} from '@/services/maintenance-mode/maintenance-mode-queues.service'
import {
  getMaintenanceMode,
  reloadMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getMaintenanceModeStatus } from '@/services/maintenance-mode/maintenance-mode.service'
import {
  closeQueue,
  getAllQueues,
  getEmailQueue,
  getQueueConnection,
} from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import { waitUntil } from '../../../helpers/timing'

const NOW = new Date('2026-10-06T10:00:30.000Z')
// eslint-disable-next-line unicorn/no-null -- the contract uses null for "none"
const NONE = null

/**
 * A known snapshot, at the version this process's store holds, that changed `ageMs` before `NOW`.
 * @param mode - Its mode.
 * @param ageMs - How long before `NOW` it changed.
 * @returns The snapshot.
 */
function snapshot(mode: 'off' | 'read_only' | 'full', ageMs: number): MaintenanceModeSnapshot {
  const changedAt = new Date(NOW.getTime() - ageMs).toISOString()
  return {
    mode,
    message: mode === 'off' ? undefined : 'Back soon.',
    since: mode === 'off' ? undefined : changedAt,
    changedAt,
    version: getMaintenanceMode().version,
    known: true,
  } as unknown as MaintenanceModeSnapshot
}

/**
 * Each registry queue's pause flag.
 * @returns `name: paused` pairs.
 */
async function pauseFlags(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    getAllQueues().map(async (queue) => [queue.name, await queue.isPaused()] as const)
  )
  return Object.fromEntries(entries)
}

const ALL_PAUSED = { email: true, notification: true, maintenance: true, analytics: true }
const NONE_PAUSED = { email: false, notification: false, maintenance: false, analytics: false }

beforeEach(async () => {
  await setAllQueuesPaused(false)
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetQueueFailureStreaks()
  await setAllQueuesPaused(false)
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterAll(async () => {
  await closeQueue()
})

describe('reconcileQueuePause', () => {
  it('pauses every queue for full past the grace, healing a pause that was missed', async () => {
    await reconcileQueuePause(snapshot('full', 60_000), NOW)

    expect(await pauseFlags()).toEqual(ALL_PAUSED)
  })

  it('leaves queues the changing request paused alone inside the grace', async () => {
    await setAllQueuesPaused(true)

    await reconcileQueuePause(snapshot('full', 3000), NOW)

    expect(await pauseFlags()).toEqual(ALL_PAUSED)
  })

  it('does not pause inside the grace either', async () => {
    await reconcileQueuePause(snapshot('full', 3000), NOW)

    expect(await pauseFlags()).toEqual(NONE_PAUSED)
  })

  it('resumes every queue once the mode leaves full', async () => {
    await setAllQueuesPaused(true)

    await reconcileQueuePause(snapshot('read_only', 0), NOW)

    expect(await pauseFlags()).toEqual(NONE_PAUSED)
  })

  it('still reconciles the other queues when one fails, logging once per failing streak', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failing = vi
      .spyOn(getEmailQueue(), 'isPaused')
      .mockRejectedValue(new Error('Connection is closed.'))

    await reconcileQueuePause(snapshot('full', 60_000), NOW)
    await reconcileQueuePause(snapshot('full', 60_000), NOW)

    failing.mockRestore()
    expect(await pauseFlags()).toEqual({ ...ALL_PAUSED, email: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

const DEDUPE_WARNING =
  'Duplicate scheduler runs could not be removed before the queue resumed; duplicate runs may follow'

/**
 * Pause every queue, then reconcile to `read_only`, which resumes them.
 */
async function pauseThenResume(): Promise<void> {
  await setAllQueuesPaused(true)
  await reconcileQueuePause(snapshot('read_only', 0), NOW)
}

describe('the failure streaks', () => {
  it('logs a failing duplicate cleanup once per streak, and again once the streaks are reset', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(getEmailQueue(), 'getJobSchedulers').mockRejectedValue(
      new Error('Connection is closed.')
    )
    const dedupeWarnings = (): number =>
      warn.mock.calls.filter(([message]) => message === DEDUPE_WARNING).length

    await pauseThenResume()
    await pauseThenResume()
    expect(dedupeWarnings()).toBe(1)

    resetQueueFailureStreaks()
    await pauseThenResume()
    expect(dedupeWarnings()).toBe(2)
    expect(await pauseFlags()).toEqual(NONE_PAUSED)
  })

  // Follows a test that ends in a failing streak; only the afterEach reset lets this log its first failure.
  it('starts every test with no queue in a failing streak', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(getEmailQueue(), 'getJobSchedulers').mockRejectedValue(
      new Error('Connection is closed.')
    )

    await pauseThenResume()

    expect(warn.mock.calls.filter(([message]) => message === DEDUPE_WARNING)).toHaveLength(1)
  })
})

describe('a reconcile for a superseded snapshot', () => {
  it('does not pause when the store has moved on', async () => {
    const stale = snapshot('full', 60_000)
    await storeMaintenanceMode('off')
    await reloadMaintenanceMode()

    await reconcileQueuePause(stale, NOW)

    expect(await pauseFlags()).toEqual(NONE_PAUSED)
  })

  it('does not resume when the store has moved on', async () => {
    await setAllQueuesPaused(true)
    const stale = snapshot('read_only', 0)
    await storeMaintenanceMode('full', { changedAt: new Date(0) })
    await reloadMaintenanceMode()

    await reconcileQueuePause(stale, NOW)

    expect(await pauseFlags()).toEqual(ALL_PAUSED)
  })

  it('rechecks the version just before each pause, so a change landing mid-reconcile wins', async () => {
    const stale = snapshot('full', 60_000)
    let moved: Promise<void> | undefined
    const moveStore = (): Promise<void> => {
      moved ??= (async () => {
        await storeMaintenanceMode('off')
        await reloadMaintenanceMode()
      })()
      return moved
    }
    for (const queue of getAllQueues()) {
      vi.spyOn(queue, 'isPaused').mockImplementation(async () => {
        await moveStore()
        return false
      })
    }

    await reconcileQueuePause(stale, NOW)

    vi.restoreAllMocks()
    expect(await pauseFlags()).toEqual(NONE_PAUSED)
  })
})

describe('resuming when the duplicate cleanup fails', () => {
  it('still resumes the queue, warning once per streak that duplicate runs may follow', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(getEmailQueue(), 'getJobSchedulers').mockRejectedValue(new Error('boom'))
    await setAllQueuesPaused(true)

    await setAllQueuesPaused(false)
    await setAllQueuesPaused(true)
    await setAllQueuesPaused(false)

    expect(await pauseFlags()).toEqual(NONE_PAUSED)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/duplicate/i)
  })

  it('says the pause state could not be checked or resumed, and a later reload retries, when its resume fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await setAllQueuesPaused(true)
    vi.spyOn(getEmailQueue(), 'resume').mockRejectedValue(new Error('Connection is closed.'))

    await setAllQueuesPaused(false)

    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /pause state could not be checked or resumed.*later reload retries the resume/i
    )
  })
})

describe('queue pause states', () => {
  it('reports each queue paused or not with its running jobs', async () => {
    await setAllQueuesPaused(true)

    const states = await getQueuePauseStates()

    expect(states).toEqual([
      { name: 'email', paused: true, active: 0 },
      { name: 'notification', paused: true, active: 0 },
      { name: 'maintenance', paused: true, active: 0 },
      { name: 'analytics', paused: true, active: 0 },
    ])
  })

  it('reports null for a queue Redis could not answer for', async () => {
    vi.spyOn(getEmailQueue(), 'getActiveCount').mockRejectedValue(
      new Error('Connection is closed.')
    )

    const states = await getQueuePauseStates()

    expect(states[0]).toEqual({ name: 'email', paused: false, active: NONE })
  })

  it('builds the status section from the store, the queues and the reload state', async () => {
    const changedAt = new Date('2026-10-06T10:42:00.000Z')
    await storeMaintenanceMode('full', { changedAt })
    await reloadMaintenanceMode()
    await setAllQueuesPaused(true)

    const status = await getMaintenanceModeStatus()

    expect(status).toMatchObject({
      mode: 'full',
      since: changedAt.toISOString(),
      known: true,
      queuesPaused: true,
      noticesPending: false,
      lastReloadError: NONE,
    })
    expect(status.queues).toHaveLength(4)
  })
})

describe('dedupeSchedulerJobs', () => {
  const queues: Queue[] = []

  /**
   * A queue of its own under this worker's prefix, removed after the test.
   * @returns The queue.
   */
  function scratchQueue(): Queue {
    const queue = new Queue(`mm-dedupe-${randomUUID()}`, {
      connection: getQueueConnection(),
      prefix: redisKey('bull'),
    })
    queues.push(queue)
    return queue
  }

  afterEach(async () => {
    await Promise.all(queues.map((queue) => queue.obliterate({ force: true })))
    await Promise.all(queues.map((queue) => queue.close()))
    queues.length = 0
  })

  it('removes nothing from a queue without schedulers', async () => {
    const queue = scratchQueue()
    await queue.add('plain', {})

    expect(await dedupeSchedulerJobs(queue)).toBe(0)
  })

  it('cuts a paused scheduler re-upserted while its run was pending down to its next run', async () => {
    const queue = scratchQueue()
    const template = { name: 'tick', opts: { removeOnComplete: true } }
    await queue.pause()
    await queue.upsertJobScheduler('tick', { every: 200 }, template)
    // With no Worker, a scheduler's first run lands in `wait` at once; a re-upsert then adds its next run as a second pending job (probe P1b).
    const pending = async (): Promise<number> => {
      const counts = await queue.getJobCounts('wait', 'delayed')
      return (counts.wait ?? 0) + (counts.delayed ?? 0)
    }
    await waitUntil(async () => (await pending()) >= 1, {
      message: 'the first run is pending while paused',
    })
    await queue.upsertJobScheduler('tick', { every: 200 }, template)
    await waitUntil(async () => (await pending()) >= 2, {
      message: 'the re-upsert added a second pending run',
    })

    const removed = await dedupeSchedulerJobs(queue)

    const [scheduler] = await queue.getJobSchedulers(0, -1)
    const left = await queue.getJobs(['wait', 'delayed', 'prioritized'], 0, -1)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(left.map((job) => job.id)).toEqual([`repeat:tick:${String(scheduler?.next)}`])
  })

  it('never removes a scheduler’s only pending run', async () => {
    const queue = scratchQueue()
    await queue.pause()
    await queue.upsertJobScheduler('tick', { every: 60_000 }, { name: 'tick' })

    expect(await dedupeSchedulerJobs(queue)).toBe(0)
    expect(await queue.getJobs(['wait', 'delayed', 'prioritized'], 0, -1)).toHaveLength(1)
  })
})
