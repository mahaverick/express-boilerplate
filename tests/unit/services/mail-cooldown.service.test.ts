/**
 * @file `claimCooldown` and `didClaimMailCooldown`: one Redis `SET NX PX` per
 * key and scope, the time left read with `PTTL` when the slot is held, the
 * address never in a mail cooldown's key, and the caller's choice when Redis
 * fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimCooldown,
  didClaimMailCooldown,
  releaseCooldown,
} from '@/services/mail-cooldown.service'
import { resetRedisDeadlineForTests } from '@/services/redis-deadline.service'
import { getRedis } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'

vi.mock('@/services/redis.service', () => ({
  getRedis: vi.fn(),
  redisKey: (...parts: string[]) => ['test', ...parts].join(':'),
}))

const set = vi.fn<(key: string, value: string, options: unknown) => Promise<string | null>>()
const pttl = vi.fn<(key: string) => Promise<number>>()
const del = vi.fn<(key: string) => Promise<number>>()

beforeEach(() => {
  resetRedisDeadlineForTests()
  set.mockReset()
  pttl.mockReset()
  del.mockReset()
  vi.mocked(getRedis).mockReset()
  vi.mocked(getRedis).mockResolvedValue({ set, pTTL: pttl, del } as unknown as Awaited<
    ReturnType<typeof getRedis>
  >)
})

describe('claimCooldown', () => {
  it('claims the slot when the SET wins, keyed on the scope and the key as given', async () => {
    set.mockResolvedValue('OK')

    await expect(claimCooldown('step-up-link', 'user-1', 60_000)).resolves.toEqual({
      claimed: true,
    })
    expect(set).toHaveBeenCalledWith('test:step-up-link:user-1', '1', { NX: true, PX: 60_000 })
    expect(pttl).not.toHaveBeenCalled()
  })

  it('answers the time left on the held slot from PTTL', async () => {
    // eslint-disable-next-line unicorn/no-null -- node-redis answers null for a SET NX that did not write
    set.mockResolvedValue(null)
    pttl.mockResolvedValue(41_250)

    await expect(claimCooldown('step-up-link', 'user-1', 60_000)).resolves.toEqual({
      claimed: false,
      retryAfterMs: 41_250,
    })
    expect(pttl).toHaveBeenCalledWith('test:step-up-link:user-1')
  })

  it.each([
    ['the key expired between the two commands (-2)', -2],
    ['the key has no expiry (-1)', -1],
  ])('answers a positive wait when %s', async (_label, answer) => {
    // eslint-disable-next-line unicorn/no-null -- node-redis answers null for a SET NX that did not write
    set.mockResolvedValue(null)
    pttl.mockResolvedValue(answer)

    const result = await claimCooldown('step-up-link', 'user-1', 60_000)

    expect(result.claimed).toBe(false)
    expect(result.claimed ? 0 : result.retryAfterMs).toBeGreaterThan(0)
  })

  it('answers the whole cooldown when PTTL fails after a held slot', async () => {
    // eslint-disable-next-line unicorn/no-null -- node-redis answers null for a SET NX that did not write
    set.mockResolvedValue(null)
    pttl.mockRejectedValue(new Error('redis down'))

    await expect(claimCooldown('step-up-link', 'user-1', 60_000)).resolves.toEqual({
      claimed: false,
      retryAfterMs: 60_000,
    })
  })

  it('fails open to claimed when Redis cannot be reached', async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('redis down'))

    await expect(claimCooldown('step-up-link', 'user-1', 60_000)).resolves.toEqual({
      claimed: true,
    })
  })

  it('fails open to claimed within the deadline when Redis does not answer', async () => {
    set.mockImplementation(stalledCommand)

    expect(await answerWithinBound(claimCooldown('step-up-link', 'user-1', 60_000))).toEqual({
      claimed: true,
    })
  })
})

describe('releaseCooldown', () => {
  it('deletes the slot under the same key the claim used', async () => {
    del.mockResolvedValue(1)

    await releaseCooldown('step-up-link', 'user-1')

    expect(del).toHaveBeenCalledWith('test:step-up-link:user-1')
  })

  it('never rejects when Redis cannot be reached', async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('redis down'))

    await expect(releaseCooldown('step-up-link', 'user-1')).resolves.toBeUndefined()
  })
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

  it.each([
    { whenUnavailable: 'send' as const, expected: true },
    { whenUnavailable: 'skip' as const, expected: false },
  ])(
    "answers the caller's choice ($whenUnavailable) within the deadline when Redis does not answer",
    async ({ whenUnavailable, expected }) => {
      set.mockImplementation(stalledCommand)
      expect(
        await answerWithinBound(
          didClaimMailCooldown('password-reset-notice', 'owner@example.com', 300_000, {
            whenUnavailable,
          })
        )
      ).toBe(expected)
    }
  )
})
