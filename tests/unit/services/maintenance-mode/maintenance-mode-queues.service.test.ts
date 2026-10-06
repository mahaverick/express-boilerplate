/**
 * @file `queuePauseTarget`, the pause grace: a reload pauses only for a
 * known `full` at least `MAINTENANCE_MODE_PAUSE_GRACE_MS` old, leaves the
 * queues alone for a younger `full` or an unknown mode, and resumes them
 * for every other mode; and `dedupeSchedulerJobs`' choice of the run to keep
 * when no run has the scheduler's next-run id, and a removal that fails.
 */
import type { Queue } from 'bullmq'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAINTENANCE_MODE_PAUSE_GRACE_MS } from '@/constants/maintenance-mode.constants'
import { logger } from '@/services/logger.service'
import {
  dedupeSchedulerJobs,
  queuePauseTarget,
} from '@/services/maintenance-mode/maintenance-mode-queues.service'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null for "none"
const NONE = null
const NOW = new Date('2026-10-06T10:00:30.000Z')

/**
 * A known snapshot that changed `ageMs` before `NOW`.
 * @param mode - Its mode.
 * @param ageMs - How long before `NOW` it changed.
 * @returns The snapshot.
 */
function snapshot(mode: MaintenanceModeSnapshot['mode'], ageMs: number): MaintenanceModeSnapshot {
  const changedAt = new Date(NOW.getTime() - ageMs).toISOString()
  return {
    mode,
    message: mode === 'off' ? undefined : 'Back soon.',
    since: mode === 'off' ? undefined : changedAt,
    changedAt,
    version: 3,
    known: true,
  } as unknown as MaintenanceModeSnapshot
}

describe('queuePauseTarget', () => {
  it('pauses for full once the change is as old as the grace', () => {
    expect(queuePauseTarget(snapshot('full', MAINTENANCE_MODE_PAUSE_GRACE_MS), NOW)).toBe('pause')
    expect(queuePauseTarget(snapshot('full', 60_000), NOW)).toBe('pause')
  })

  it('leaves the queues alone for full inside the grace, neither pausing nor resuming', () => {
    expect(queuePauseTarget(snapshot('full', 3000), NOW)).toBe('leave')
    expect(queuePauseTarget(snapshot('full', MAINTENANCE_MODE_PAUSE_GRACE_MS - 1), NOW)).toBe(
      'leave'
    )
  })

  it('resumes for off and read_only at once, whatever their age', () => {
    expect(queuePauseTarget(snapshot('off', 0), NOW)).toBe('resume')
    expect(queuePauseTarget(snapshot('read_only', 0), NOW)).toBe('resume')
  })

  it('leaves the queues alone while the mode is unknown', () => {
    expect(queuePauseTarget({ ...snapshot('off', 0), known: false }, NOW)).toBe('leave')
  })
})

describe('queuePauseTarget without a change time', () => {
  it('leaves the queues alone for a full that has no changedAt', () => {
    expect(queuePauseTarget({ ...snapshot('full', 60_000), changedAt: NONE }, NOW)).toBe('leave')
  })

  it('leaves the queues alone for a full that is not known, however old', () => {
    expect(queuePauseTarget({ ...snapshot('full', 60_000), known: false }, NOW)).toBe('leave')
  })
})

interface StubRun {
  id: string
  repeatJobKey: string
  timestamp: number
  opts: { delay: number }
  remove: ReturnType<typeof vi.fn>
}

/**
 * A pending run of the scheduler `tick`.
 * @param id - Its id.
 * @param dueAtMs - When it is due.
 * @param remove - What removing it does.
 * @returns The job.
 */
function run(
  id: string,
  dueAtMs: number,
  remove: () => Promise<void> = () => Promise.resolve()
): StubRun {
  return {
    id,
    repeatJobKey: 'tick',
    timestamp: dueAtMs,
    opts: { delay: 0 },
    remove: vi.fn(remove),
  }
}

/**
 * A queue holding one scheduler and some pending runs.
 * @param runs - The pending runs.
 * @param state - What `getJobState` answers.
 * @returns The queue.
 */
function queueOf(runs: StubRun[], state = 'waiting'): Queue {
  return {
    name: 'stub',
    getJobSchedulers: () => Promise.resolve([{ key: 'tick', next: 99 }]),
    getJobs: () => Promise.resolve(runs),
    getJobState: () => Promise.resolve(state),
  } as unknown as Queue
}

describe('dedupeSchedulerJobs against a stubbed queue', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the run due latest, and removes the rest, when none has the next-run id', async () => {
    const early = run('repeat:tick:1', 1000)
    const latest = run('repeat:tick:3', 3000)
    const middle = run('repeat:tick:2', 2000)

    const removed = await dedupeSchedulerJobs(queueOf([early, latest, middle]))

    expect(removed).toBe(2)
    expect(early.remove).toHaveBeenCalledTimes(1)
    expect(middle.remove).toHaveBeenCalledTimes(1)
    expect(latest.remove).not.toHaveBeenCalled()
  })

  it('warns and does not count a duplicate that cannot be removed and still exists', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const kept = run('repeat:tick:99', 1000)
    const locked = run('repeat:tick:1', 500, () => Promise.reject(new Error('locked')))

    const removed = await dedupeSchedulerJobs(queueOf([kept, locked], 'active'))

    expect(removed).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ queue: 'stub', jobId: 'repeat:tick:1' })
  })

  it('counts nothing and stays quiet for a duplicate another replica already removed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const kept = run('repeat:tick:99', 1000)
    const gone = run('repeat:tick:1', 500, () => Promise.reject(new Error('missing')))

    const removed = await dedupeSchedulerJobs(queueOf([kept, gone], 'unknown'))

    expect(removed).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })
})
