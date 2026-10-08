/**
 * @file `didClaimMailCooldown`: one Redis `SET NX PX` per address and scope, the
 * address never in the key, and the caller's choice when Redis fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { didClaimMailCooldown } from '@/services/mail-cooldown.service'
import { getRedis } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

vi.mock('@/services/redis.service', () => ({
  getRedis: vi.fn(),
  redisKey: (...parts: string[]) => ['test', ...parts].join(':'),
}))

const set = vi.fn<(key: string, value: string, options: unknown) => Promise<string | null>>()

beforeEach(() => {
  set.mockReset()
  vi.mocked(getRedis).mockReset()
  vi.mocked(getRedis).mockResolvedValue({ set } as unknown as Awaited<ReturnType<typeof getRedis>>)
})

describe('didClaimMailCooldown', () => {
  it('claims the slot when the SET wins, with NX and the cooldown as PX', async () => {
    set.mockResolvedValue('OK')

    await expect(
      didClaimMailCooldown('password-reset-notice', 'Owner@Example.com', 300_000, {
        whenUnavailable: 'send',
      })
    ).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith(expect.any(String), '1', { NX: true, PX: 300_000 })
  })

  it('rounds a fractional cooldown up to a whole PX, which Redis requires', async () => {
    set.mockResolvedValue('OK')

    await expect(
      didClaimMailCooldown('password-reset-notice', 'owner@example.com', 1.5, {
        whenUnavailable: 'send',
      })
    ).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith(expect.any(String), '1', { NX: true, PX: 2 })
  })

  it('refuses the slot while one is held (the SET answers null)', async () => {
    // eslint-disable-next-line unicorn/no-null -- node-redis answers null for a SET NX that did not write
    set.mockResolvedValue(null)

    await expect(
      didClaimMailCooldown('password-reset-notice', 'owner@example.com', 300_000, {
        whenUnavailable: 'send',
      })
    ).resolves.toBe(false)
  })

  it('keys on the scope and a digest of the trimmed, lowercased address, never the address', async () => {
    set.mockResolvedValue('OK')

    await didClaimMailCooldown('password-reset-notice', ' Owner@Example.com ', 1000, {
      whenUnavailable: 'send',
    })
    await didClaimMailCooldown('password-reset-notice', 'owner@example.com', 1000, {
      whenUnavailable: 'send',
    })
    await didClaimMailCooldown('registration-attempt-notice', 'owner@example.com', 1000, {
      whenUnavailable: 'skip',
    })

    const [first, second, third] = set.mock.calls.map((call) => call[0])
    expect(first).toBe(`test:password-reset-notice:${hashRateLimitIdentity('owner@example.com')}`)
    expect(second).toBe(first)
    expect(third).toMatch(/^test:registration-attempt-notice:/)
    expect(set.mock.calls.map((call) => call[0]).join(' ')).not.toContain('example.com')
  })

  it("answers the caller's choice when Redis cannot be reached", async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('redis down'))

    await expect(
      didClaimMailCooldown('password-reset-notice', 'owner@example.com', 1000, {
        whenUnavailable: 'send',
      })
    ).resolves.toBe(true)
    await expect(
      didClaimMailCooldown('registration-attempt-notice', 'owner@example.com', 1000, {
        whenUnavailable: 'skip',
      })
    ).resolves.toBe(false)
  })
})
