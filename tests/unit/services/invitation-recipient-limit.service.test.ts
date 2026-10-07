/**
 * @file The recipient ceiling fails open: with Redis unreachable an
 * invitation is let through and a warning is logged, as the limiters do. Its
 * key names the address only through `hashRateLimitIdentity`, and a tenant
 * past its share is refused before the address's own count is touched.
 * The counting itself is proven against Redis in
 * tests/integration/api/invitation.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  INVITATION_RECIPIENT_TENANT_SHARE,
  spendInvitationRecipientBudget,
} from '@/services/invitation-recipient-limit.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

const TENANT_ID = '00000000-0000-4000-8000-000000000001'

/**
 * Stand in a Redis whose successive INCRs answer `counts`, once.
 * @param counts - What each INCR returns, in order.
 * @returns The keys incremented, filled in as the code runs.
 */
function spentKeys(counts: number[]): string[] {
  const keys: string[] = []
  const pending = [...counts]
  const multi = () => {
    let count = 0
    const transaction = {
      incr: (key: string) => {
        keys.push(key)
        count = pending.shift() ?? 1
        return transaction
      },
      pExpire: () => transaction,
      exec: () => Promise.resolve([count, true]),
    }
    return transaction
  }
  vi.mocked(getRedis).mockResolvedValueOnce({ multi } as never)
  return keys
}

describe('spendInvitationRecipientBudget', () => {
  it('lets the invitation through and warns when Redis is unreachable', async () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      await expect(spendInvitationRecipientBudget('Someone@Example.test', TENANT_ID)).resolves.toBe(
        'spent'
      )
      const [message, meta] = warn.mock.calls.at(-1) ?? []
      expect(message).toBe('Invitation recipient budget unavailable; allowing the invitation')
      expect((meta as { error?: unknown } | undefined)?.error).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
    }
  })

  it('keys the counts on the HMAC of the trimmed, lowercased address, the tenant share first', async () => {
    const keys = spentKeys([1, 1])
    await expect(
      spendInvitationRecipientBudget('  Someone@Example.test ', TENANT_ID)
    ).resolves.toBe('spent')
    const recipient = redisKey(
      'rl',
      'invitation-recipient',
      hashRateLimitIdentity('someone@example.test')
    )
    expect(keys).toEqual([`${recipient}:${TENANT_ID}`, recipient])
  })

  it('refuses past the tenant share without spending the address budget', async () => {
    const keys = spentKeys([INVITATION_RECIPIENT_TENANT_SHARE + 1])
    await expect(spendInvitationRecipientBudget('someone@example.test', TENANT_ID)).resolves.toBe(
      'exhausted'
    )
    expect(keys).toHaveLength(1)
    expect(keys[0]?.endsWith(`:${TENANT_ID}`)).toBe(true)
  })
})
