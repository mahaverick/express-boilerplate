/**
 * @file The recipient ceiling fails open: with Redis unreachable an
 * invitation is let through and a warning is logged, as the limiters do. Its
 * key names the address only through `hashRateLimitIdentity`.
 * The counting itself is proven against Redis in
 * tests/integration/api/invitation.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { spendInvitationRecipientBudget } from '@/services/invitation-recipient-limit.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

describe('spendInvitationRecipientBudget', () => {
  it('lets the invitation through and warns when Redis is unreachable', async () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      await expect(spendInvitationRecipientBudget('Someone@Example.test')).resolves.toBe('spent')
      const [message, meta] = warn.mock.calls.at(-1) ?? []
      expect(message).toBe('Invitation recipient budget unavailable; allowing the invitation')
      expect((meta as { error?: unknown } | undefined)?.error).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
    }
  })

  it('keys the count on the HMAC of the trimmed, lowercased address', async () => {
    const keys: string[] = []
    const transaction = {
      incr: (key: string) => {
        keys.push(key)
        return transaction
      },
      pExpire: () => transaction,
      exec: () => Promise.resolve([1, true]),
    }
    vi.mocked(getRedis).mockResolvedValueOnce({ multi: () => transaction } as never)
    await expect(spendInvitationRecipientBudget('  Someone@Example.test ')).resolves.toBe('spent')
    expect(keys).toEqual([
      redisKey('rl', 'invitation-recipient', hashRateLimitIdentity('someone@example.test')),
    ])
  })
})
