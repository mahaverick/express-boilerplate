// tests/integration/helpers/lock-probe.test.ts
//
// Real Postgres: the probe opens its own connection, as it does for every caller.
import { describe, expect, it } from 'vitest'
import { deferred, pollUntil } from '../../helpers/lock-probe'

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
})
