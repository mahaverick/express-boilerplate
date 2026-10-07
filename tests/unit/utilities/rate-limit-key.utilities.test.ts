/**
 * @file `hashRateLimitIdentity`: an HMAC of the identity under a key derived
 * from SESSION_SECRET, so a rate-limit key never names an address and its
 * digest cannot be recomputed without the secret.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Load the function against a fixed SESSION_SECRET.
 * @param secret - The SESSION_SECRET getEnv answers.
 * @returns The function.
 */
async function load(
  secret: string
): Promise<typeof import('@/utilities/rate-limit-key.utilities').hashRateLimitIdentity> {
  vi.doMock('@/configs/env.config', () => ({ getEnv: () => ({ SESSION_SECRET: secret }) }))
  const module = await import('@/utilities/rate-limit-key.utilities')
  return module.hashRateLimitIdentity
}

const SECRET = 'a-session-secret-that-is-long-enough-32'

describe('hashRateLimitIdentity', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('is the first 32 hex characters of HMAC-SHA256 under HKDF(SESSION_SECRET, "rate-limit-identity-v1")', async () => {
    const hashRateLimitIdentity = await load(SECRET)
    const key = Buffer.from(hkdfSync('sha256', SECRET, '', 'rate-limit-identity-v1', 32))
    const expected = createHmac('sha256', key)
      .update('owner@example.com')
      .digest('hex')
      .slice(0, 32)

    expect(hashRateLimitIdentity('owner@example.com')).toBe(expected)
    expect(hashRateLimitIdentity('owner@example.com')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable for one value and differs between values', async () => {
    const hashRateLimitIdentity = await load(SECRET)

    expect(hashRateLimitIdentity('a@example.com')).toBe(hashRateLimitIdentity('a@example.com'))
    expect(hashRateLimitIdentity('a@example.com')).not.toBe(hashRateLimitIdentity('b@example.com'))
  })

  it('changes with SESSION_SECRET, so a digest cannot be precomputed without it', async () => {
    const first = (await load(SECRET))('owner@example.com')
    vi.resetModules()
    const second = (await load(`${SECRET}-rotated`))('owner@example.com')

    expect(first).not.toBe(second)
  })
})
