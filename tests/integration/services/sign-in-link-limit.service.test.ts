/**
 * @file The per-address daily ceiling on sign-in link mail, against the real
 * Redis: `SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT` sends are spent and the next is
 * refused, and a Redis that does not answer lets the send through within the
 * request deadline. Each test uses a fresh address, so no count carries over.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { resetRedisDeadlineForTests } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { spendSignInLinkBudget } from '@/services/sign-in-link-limit.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return { ...actual, getRedis: vi.fn(actual.getRedis) }
})

/**
 * The addresses this file counted, whose keys `afterEach` deletes.
 */
const spentEmails: string[] = []

/**
 * A fresh address, recorded for cleanup.
 * @returns The address.
 */
function freshEmail(): string {
  const email = `budget-${randomUUID()}@example.test`
  spentEmails.push(email)
  return email
}

beforeEach(() => {
  resetRedisDeadlineForTests()
})

afterEach(async () => {
  resetRedisDeadlineForTests()
  const keys = spentEmails.map((email) =>
    redisKey('rl', 'sign-in-link-recipient', hashRateLimitIdentity(email))
  )
  spentEmails.length = 0
  if (keys.length === 0) return
  const redis = await getRedis()
  await redis.del(keys)
})

describe('spendSignInLinkBudget', () => {
  it('allows SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT sends and refuses the next', async () => {
    const email = freshEmail()
    const limit = getEnv().SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT

    for (let index = 0; index < limit; index += 1) {
      await expect(spendSignInLinkBudget(email)).resolves.toBe('spent')
    }

    await expect(spendSignInLinkBudget(email)).resolves.toBe('exhausted')
    // Keyed on the address's digest, in any case, so a casing change shares the count.
    await expect(spendSignInLinkBudget(email.toUpperCase())).resolves.toBe('exhausted')
    const redis = await getRedis()
    const ttl = await redis.pTTL(
      redisKey('rl', 'sign-in-link-recipient', hashRateLimitIdentity(email))
    )
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('fails open when Redis does not answer', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const transaction = {
        incr: () => transaction,
        pExpire: () => transaction,
        exec: stalledCommand,
      }
      vi.mocked(getRedis).mockResolvedValueOnce({ multi: () => transaction } as never)

      const spending = spendSignInLinkBudget(freshEmail())
      expect(await answerWithinBound(spending)).toBe('spent')
      const anError = expect.any(Error) as unknown
      expect(warn).toHaveBeenCalledWith(
        'Sign-in link recipient budget unavailable; allowing the link',
        expect.objectContaining({ error: anError })
      )
    } finally {
      warn.mockRestore()
    }
  })
})
