/**
 * @file The error-tracking counters against the real Redis: what one
 * process writes, another reads back (the status sums the shared keys), the
 * 15-minute window's edge, the 20-minute expiry, and the last-send keys.
 * Writes use a fixed minute, so no other file's keys can be counted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  countErrorOutcome,
  getErrorTrackingStatus,
  recordErrorSendError,
  recordErrorSendOk,
} from '@/services/errors/error-counters.service'
import { getRedis, redisKey } from '@/services/redis.service'

const AT = new Date('2020-01-01T00:14:30.000Z')
const MINUTE = Math.floor(AT.getTime() / 60_000)
const OUTCOMES = ['sent', 'throttled', 'buffer_full', 'rejected', 'retry_exhausted']

afterEach(async () => {
  const redis = await getRedis()
  const keys = OUTCOMES.flatMap((outcome) =>
    Array.from({ length: 16 }, (_, index) => redisKey('errors', outcome, String(MINUTE - index)))
  )
  await redis.del([
    ...keys,
    redisKey('errors', 'last_send_ok_at'),
    redisKey('errors', 'last_send_error'),
  ])
})

describe('error-tracking counters', () => {
  it('sums every writer’s counts over the last 15 minutes', async () => {
    await countErrorOutcome('sent', 2, AT)
    await countErrorOutcome('sent', 3, AT)
    await countErrorOutcome('sent', 5, new Date(AT.getTime() - 14 * 60_000))
    await countErrorOutcome('sent', 100, new Date(AT.getTime() - 15 * 60_000))
    await countErrorOutcome('throttled', 4, AT)
    await countErrorOutcome('retry_exhausted', 1, AT)
    const status = await getErrorTrackingStatus(AT)
    expect(status).toMatchObject({
      sent: 10,
      dropped: { throttled: 4, buffer_full: 0, rejected: 0, retry_exhausted: 1 },
    })
  })

  it('expires each bucket after 20 minutes', async () => {
    await countErrorOutcome('rejected', 1, AT)
    const redis = await getRedis()
    const ttl = await redis.ttl(redisKey('errors', 'rejected', String(MINUTE)))
    expect(ttl).toBeGreaterThan(1190)
    expect(ttl).toBeLessThanOrEqual(1200)
  })

  it('reads back the last send, and clears the last error after an acknowledged send', async () => {
    await recordErrorSendError(401)
    const failed = await getErrorTrackingStatus(AT)
    expect(failed.lastSendOkAt).toBeNull()
    expect(failed.lastSendError).toBe(401)
    await recordErrorSendOk(AT)
    const recovered = await getErrorTrackingStatus(AT)
    expect(recovered.lastSendOkAt).toBe(AT.toISOString())
    expect(recovered.lastSendError).toBeNull()
  })
})
