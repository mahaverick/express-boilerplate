/**
 * @file `setup-global.ts` closes the Redis stall cooldown before each
 * integration test. The cooldown is per process and lasts
 * `REDIS_STALL_COOLDOWN_MS`, so without the reset one slow Redis call would
 * fail every Redis call, the fake payment provider's included, in the tests
 * that start in the next five seconds. The two tests run in order: the first
 * opens a cooldown, the second needs Redis.
 */
import { describe, expect, it } from 'vite-plus/test'
import { RedisStalledError } from '@/errors/redis-errors'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis } from '@/services/redis.service'
import { stalledCommand } from '../../helpers/redis-stall'

/**
 * A Redis round trip under the deadline.
 * @returns Redis's answer.
 */
async function ping(): Promise<string> {
  const redis = await getRedis()
  return redis.ping()
}

describe('the Redis stall cooldown between integration tests', () => {
  it('opens a cooldown when a call misses its deadline', async () => {
    await expect(withRedisDeadline(stalledCommand, 'setup-probe')).rejects.toBeInstanceOf(
      RedisStalledError
    )
    await expect(withRedisDeadline(ping, 'setup-probe')).rejects.toBeInstanceOf(RedisStalledError)
  })

  it('reaches Redis in the next test, because the setup closes the cooldown', async () => {
    await expect(withRedisDeadline(ping, 'setup-probe')).resolves.toBe('PONG')
  })
})
