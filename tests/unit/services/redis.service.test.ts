// tests/unit/services/redis.service.test.ts
//
// redisKey only: the connection logic is covered against a real Redis in
// tests/integration/services/redis.service.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { redisKey } from '@/services/redis.service'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), REDIS_KEY_PREFIX: 'acme-prod' }) }
})

describe('redisKey', () => {
  it('puts REDIS_KEY_PREFIX first and joins every part with a colon', () => {
    expect(redisKey('denylist', 'session', 'abc')).toBe('acme-prod:denylist:session:abc')
  })

  it('names a single keyspace', () => {
    expect(redisKey('bull')).toBe('acme-prod:bull')
  })

  it('returns the bare prefix when given no parts', () => {
    expect(redisKey()).toBe('acme-prod')
  })
})
