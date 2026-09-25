import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'

const redis = {
  set: vi.fn<(key: string, value: string, options: unknown) => Promise<string>>(),
  exists: vi.fn<(key: string) => Promise<number>>(),
}

// Written out rather than built with redisKey, so the test pins the key shape itself.
const deniedKey = (): string => `${getEnv().REDIS_KEY_PREFIX}:denylist:session:session-abc`

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: () => Promise.resolve(redis),
}))
vi.mock('@/services/logger.service', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('session denylist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.set.mockResolvedValue('OK')
    redis.exists.mockResolvedValue(0)
  })

  it('denies a session with a TTL equal to ACCESS_TOKEN_TTL, so the entry dies when the tokens do', async () => {
    const { denySession } = await import('@/services/session-denylist.service')
    await denySession('session-abc')

    // Computed from the same source the service reads (getEnv().ACCESS_TOKEN_TTL),
    // not a hard-coded number: this asserts the ACTUAL invariant the
    // service's own comment calls "the whole design" — not merely
    // `> 0`, which an `EX` of 1 would also satisfy while defeating that
    // design entirely.
    const expectedSeconds = Math.ceil(requireDurationMs(getEnv().ACCESS_TOKEN_TTL) / MS_PER_SECOND)
    expect(redis.set).toHaveBeenCalledWith(deniedKey(), '1', {
      expiration: { type: 'EX', value: expectedSeconds },
    })
  })

  it('reports a denied session', async () => {
    redis.exists.mockResolvedValue(1)
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(true)
    expect(redis.exists).toHaveBeenCalledWith(deniedKey())
  })

  it('ALLOWS when Redis is unreachable, rather than locking everyone out', async () => {
    // Fail-open is the deliberate trade. Failing closed turns a Redis blip
    // into a total outage; failing open returns to the pre-existing 15-minute
    // window. The warning is what makes it visible.
    redis.exists.mockRejectedValue(new Error('connection refused'))
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(false)
  })

  it('never throws out of denySession, so a Redis outage cannot fail a logout', async () => {
    redis.set.mockRejectedValue(new Error('connection refused'))
    const { denySession } = await import('@/services/session-denylist.service')
    await expect(denySession('session-abc')).resolves.toBeUndefined()
  })
})
