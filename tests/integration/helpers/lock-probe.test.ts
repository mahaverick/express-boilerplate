// tests/integration/helpers/lock-probe.test.ts
//
// Real Postgres: the probe opens its own connection, as it does for every caller.
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
        startsWithinMs: 5000,
      }
    )

    await expect(unobserved).rejects.toThrow('late clock: no lock wait and no finish within 100 ms')
    expect(startedAt.ms).toBeGreaterThan(0)
    expect(Date.now() - startedAt.ms).toBeGreaterThanOrEqual(100)
  })

  it('fails when the clock does not start in time', async () => {
    const unstarted = pollUntil(
      () => Promise.resolve(false),
      deferred().promise,
      100,
      'unstarted clock',
      {
        startsOn: deferred().promise,
        startsWithinMs: 300,
      }
    )

    await expect(unstarted).rejects.toThrow(
      'unstarted clock: the clock did not start within 300 ms'
    )
  })
})
