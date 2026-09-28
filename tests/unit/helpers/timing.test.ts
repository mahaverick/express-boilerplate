/**
 * @file No database, no Redis. Where a timeout decides how many checks
 * run, the count is asserted loosely (at least N), so these tests do not
 * depend on scheduling.
 */
import { describe, expect, it } from 'vitest'
import { settle, waitUntil } from '../../helpers/timing'

describe('waitUntil', () => {
  it('resolves with the first truthy value, without waiting when it is already met', async () => {
    const value = { ready: true }

    await expect(waitUntil(() => value, { message: 'value present' })).resolves.toBe(value)
  })

  it('keeps polling until the condition is met', async () => {
    let checks = 0

    const result = await waitUntil(
      () => {
        checks += 1
        return checks >= 3 ? 'done' : ''
      },
      { message: 'third check', interval: 1 }
    )

    expect(result).toBe('done')
    expect(checks).toBe(3)
  })

  it('awaits a check that returns a promise', async () => {
    let checks = 0

    const result = await waitUntil(
      () => {
        checks += 1
        return Promise.resolve(checks >= 2 ? 42 : 0)
      },
      { message: 'second async check', interval: 1 }
    )

    expect(result).toBe(42)
  })

  it('rejects after the timeout with the message and the last value', async () => {
    let checks = 0

    const waiting = waitUntil(
      () => {
        checks += 1
        return 0
      },
      { message: 'count reaches 1', timeout: 60, interval: 5 }
    )

    await expect(waiting).rejects.toThrow('count reaches 1 (not met within 60ms; last value: 0)')
    expect(checks).toBeGreaterThanOrEqual(2)
  })

  it('treats a throwing check as not met, keeps polling, and reports the last error', async () => {
    let checks = 0

    const waiting = waitUntil(
      () => {
        checks += 1
        throw new Error(`probe failed ${String(checks)}`)
      },
      { message: 'probe answers', timeout: 60, interval: 5 }
    )

    await expect(waiting).rejects.toThrow(
      /^probe answers \(not met within 60ms; last error: Error: probe failed \d+/
    )
    expect(checks).toBeGreaterThanOrEqual(2)
  })

  it('treats a rejected check as not met, and resolves once it later returns a truthy value', async () => {
    let checks = 0

    const result = await waitUntil(
      () => {
        checks += 1
        return checks < 3 ? Promise.reject(new Error('not yet')) : Promise.resolve('recovered')
      },
      { message: 'recovers', interval: 1 }
    )

    expect(result).toBe('recovered')
  })
})

describe('settle', () => {
  it('resolves after a real delay when given a reason', async () => {
    const startedAt = performance.now()

    await settle(20, 'the delay is what this test checks')

    // A floor only: a timer never fires early, but it may fire late under load.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(15)
  })

  it.each(['', ' ', '\t\n'])('rejects the blank reason %j', async (reason) => {
    await expect(settle(1, reason)).rejects.toThrow(TypeError)
  })

  it('rejects an empty reason at compile time too', async () => {
    // @ts-expect-error -- settle's type rejects an empty reason literal.
    await expect(settle(1, '')).rejects.toThrow('settle() needs a reason')
  })
})
