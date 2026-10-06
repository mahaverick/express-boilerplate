/**
 * @file `queuePauseTarget`, the pause grace: a reload pauses only for a
 * known `full` at least `MAINTENANCE_MODE_PAUSE_GRACE_MS` old, leaves the
 * queues alone for a younger `full` or an unknown mode, and resumes them
 * for every other mode.
 */
import { describe, expect, it } from 'vitest'
import { MAINTENANCE_MODE_PAUSE_GRACE_MS } from '@/constants/maintenance-mode.constants'
import { queuePauseTarget } from '@/services/maintenance-mode/maintenance-mode-queues.service'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'

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
