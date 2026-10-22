/**
 * @file No database, no Redis. Pins how `VITEST_WORKERS` sets the number of
 * per-worker databases.
 */
import { describe, expect, it } from 'vite-plus/test'
import { workerCountFrom } from '../../helpers/worker-database'

describe('workerCountFrom', () => {
  it('defaults to 8', () => {
    expect(workerCountFrom({})).toBe(8)
  })

  it('reads VITEST_WORKERS', () => {
    expect(workerCountFrom({ VITEST_WORKERS: '4' })).toBe(4)
  })

  it.each(['0', '17', 'x', '', '4.5', ' 4 ', '0x4'])('rejects %j', (value) => {
    expect(() => workerCountFrom({ VITEST_WORKERS: value })).toThrow(
      new Error(`VITEST_WORKERS must be an integer from 1 to 16, got "${value}"`)
    )
  })
})
