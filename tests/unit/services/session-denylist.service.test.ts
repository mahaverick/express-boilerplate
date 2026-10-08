import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { resetRedisDeadlineForTests, withRedisDeadline } from '@/services/redis-deadline.service'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'

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

/**
 * A deny write that Redis has not answered yet, released by the test.
 * @returns The pending reply and the switches that settle it.
 */
function deferredWrite(): {
  reply: Promise<string>
  answer: () => void
  fail: () => void
} {
  const switches = { answer: () => {}, fail: () => {} }
  const reply = new Promise<string>((resolve, reject) => {
    switches.answer = () => resolve('OK')
    switches.fail = () => reject(new Error('connection reset'))
  })
  return { reply, ...switches }
}

describe('session denylist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRedisDeadlineForTests()
    redis.set.mockResolvedValue('OK')
    redis.exists.mockResolvedValue(0)
  })

  it('denies a session with a TTL equal to ACCESS_TOKEN_TTL, so the entry dies when the tokens do', async () => {
    const { denySession } = await import('@/services/session-denylist.service')
    expect(await denySession('session-abc')).toBe('denied')

    // Computed from the same source the service reads (getEnv().ACCESS_TOKEN_TTL), not a hard-coded number — this asserts the actual TTL value, not merely `> 0`, which an `EX` of 1 would also satisfy while defeating the point of a matching TTL.
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
    // Fail-open is the deliberate trade: failing closed turns a Redis blip into a total outage, while failing open returns to the ordinary token-expiry window; the warning is what makes it visible.
    redis.exists.mockRejectedValue(new Error('connection refused'))
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await isSessionDenied('session-abc')).toBe(false)
  })

  it('never throws out of denySession, and reports the failure, so a Redis outage cannot fail a logout', async () => {
    redis.set.mockRejectedValue(new Error('connection refused'))
    const { denySession } = await import('@/services/session-denylist.service')
    await expect(denySession('session-abc')).resolves.toBe('failed')
  })

  it('ALLOWS within the deadline when Redis is connected but does not answer, as on any other failure', async () => {
    redis.exists.mockImplementation(stalledCommand)
    const { isSessionDenied } = await import('@/services/session-denylist.service')
    expect(await answerWithinBound(isSessionDenied('session-abc'))).toBe(false)
  })

  it('answers within the deadline when the deny write stalls, and leaves the write in flight rather than dropping it', async () => {
    const write = deferredWrite()
    redis.set.mockReturnValue(write.reply)
    const warn = vi.spyOn(logger, 'warn')
    const { denySession } = await import('@/services/session-denylist.service')

    expect(await answerWithinBound(denySession('session-abc'))).toBe('pending')
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/lands when Redis answers/),
      expect.objectContaining({ sessionId: 'session-abc' })
    )

    warn.mockClear()
    write.answer()
    await write.reply
    // Landed: nothing reports it lost.
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs the loss at error, with the user id, when a deny write left in flight fails later', async () => {
    const write = deferredWrite()
    redis.set.mockReturnValue(write.reply)
    const error = vi.spyOn(logger, 'error')
    const { denySession } = await import('@/services/session-denylist.service')
    expect(await answerWithinBound(denySession('session-abc', 'user-1'))).toBe('pending')
    expect(error).not.toHaveBeenCalled()

    write.fail()
    await expect(write.reply).rejects.toThrow('connection reset')
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        'session denylist write failed after revocation',
        expect.objectContaining({ userId: 'user-1', sessionId: 'session-abc', sessionCount: 1 })
      )
    })
  })

  it('still writes the deny while a stall cooldown is open: the cooldown never skips a deny', async () => {
    await expect(withRedisDeadline(stalledCommand, 'stall')).rejects.toThrow()
    const { denySession } = await import('@/services/session-denylist.service')
    expect(await denySession('session-abc')).toBe('denied')
    expect(redis.set).toHaveBeenCalledWith(deniedKey(), '1', expect.anything())
  })
})
