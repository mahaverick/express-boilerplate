/**
 * @file Exercises `pollUntil` against the real Postgres: the probe opens its
 * own connection, as it does for every caller.
 */
import { describe, expect, it } from 'vitest'
import { deferred, pollUntil } from '../../helpers/lock-probe'
import { settle } from '../../helpers/timing'

describe('pollUntil', () => {
  it('fails at its own deadline when a probe query hangs', async () => {
    const hangingProbe = pollUntil(
      async (probe) => {
        await probe`select pg_sleep(30)`
        return true
      },
      deferred().promise,
      500,
      'hung probe'
    )

    await expect(hangingProbe).rejects.toThrow(
      'hung probe: a probe query was still running at the deadline'
    )
  }, 10_000)

  it('answers true from a probe that finishes in time', async () => {
    const observed = pollUntil(
      async (probe) => {
        const [row] = await probe<{ ok: boolean }[]>`select true as ok`
        return row?.ok === true
      },
      deferred().promise,
      5000,
      'quick probe'
    )

    await expect(observed).resolves.toBe(true)
  })

  it('counts its deadline from when the clock starts', async () => {
    const started = deferred()
    const startedAt = { ms: 0 }
    const startClock = async (): Promise<void> => {
      await settle(300, 'let the unstarted poll run past its own timeout')
      startedAt.ms = Date.now()
      started.resolve()
    }
    void startClock()
    const unobserved = pollUntil(
      () => Promise.resolve(false),
      deferred().promise,
      100,
      'late clock',
      {
        startsOn: started.promise,
        withinMs: 5000,
      }
    )

    await expect(unobserved).rejects.toThrow('late clock: no lock wait and no finish within 100 ms')
    expect(startedAt.ms).toBeGreaterThan(0)
    expect(Date.now() - startedAt.ms).toBeGreaterThanOrEqual(100)
  })

  it('never polls past its whole bound once the clock starts', async () => {
    const started = deferred()
    const startClock = async (): Promise<void> => {
      await settle(200, 'start the clock close to the whole bound')
      started.resolve()
    }
    void startClock()
    const unobserved = pollUntil(
      () => Promise.resolve(false),
      deferred().promise,
      5000,
      'bounded clock',
      { startsOn: started.promise, withinMs: 400 }
    )

    await expect(unobserved).rejects.toThrow(
      'bounded clock: no lock wait and no finish within 400 ms'
    )
  })

  it('answers true from a probe that sees the wait before the clock starts', async () => {
    const observed = pollUntil(() => Promise.resolve(true), deferred().promise, 100, 'early wait', {
      startsOn: deferred().promise,
      withinMs: 5000,
    })

    await expect(observed).resolves.toBe(true)
  })

  it('leaves the clock unstarted when its signal rejects', async () => {
    const unstarted = pollUntil(
      () => Promise.resolve(false),
      deferred().promise,
      100,
      'rejected clock',
      { startsOn: Promise.reject(new Error('no lock reached')), withinMs: 300 }
    )

    await expect(unstarted).rejects.toThrow('rejected clock: the clock did not start within 300 ms')
  })

  it('fails when the clock does not start in time', async () => {
    const unstarted = pollUntil(
      () => Promise.resolve(false),
      deferred().promise,
      100,
      'unstarted clock',
      {
        startsOn: deferred().promise,
        withinMs: 300,
      }
    )

    await expect(unstarted).rejects.toThrow(
      'unstarted clock: the clock did not start within 300 ms'
    )
  })
})
