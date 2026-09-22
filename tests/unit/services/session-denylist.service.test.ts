import { beforeEach, describe, expect, it, vi } from 'vitest'

const redis = {
  set: vi.fn<(key: string, value: string, options: unknown) => Promise<string>>(),
  exists: vi.fn<(key: string) => Promise<number>>(),
}

vi.mock('@/services/redis.service', () => ({ getRedis: () => Promise.resolve(redis) }))
vi.mock('@/services/logger.service', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('session denylist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.set.mockResolvedValue('OK')
    redis.exists.mockResolvedValue(0)
  })

  it('denies a session with a TTL, so the entry dies when the tokens do', async () => {
    const { denySession } = await import('@/services/session-denylist.service')
    await denySession('session-abc')

    expect(redis.set).toHaveBeenCalledWith(
      'denylist:session:session-abc',
      '1',
      expect.objectContaining({ EX: expect.any(Number) as number })
    )
    const options = (redis.set.mock.calls[0] as [string, string, { EX: number }])[2]
    expect(options.EX).toBeGreaterThan(0)
  })

  it('reports a denied session', async () => {
    redis.exists.mockResolvedValue(1)
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(true)
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
