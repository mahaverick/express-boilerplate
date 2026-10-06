/**
 * @file A replica that misses the change message during a real Redis
 * outage still converges from Postgres on its backstop, and pub/sub
 * delivery resumes once Redis returns. Redis is reached through a TCP proxy
 * this file owns (`tests/helpers/redis-proxy.ts`), never by stopping the
 * shared Redis; its own file because it mocks `getEnv()`'s `REDIS_URL`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { logger } from '@/services/logger.service'
import {
  createMaintenanceModeStore,
  publishMaintenanceModeChange,
  type MaintenanceModeStore,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  closeRedis,
  getRedis,
  RECONNECT_DELAY_CAP_MS,
  REDIS_CONNECT_TIMEOUT_MS,
} from '@/services/redis.service'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import { RedisProxy } from '../../../helpers/redis-proxy'
import { waitUntil } from '../../../helpers/timing'

// One capped retry delay, then one connect attempt: a client is back within it.
const RECOVERY_TIMEOUT_MS = RECONNECT_DELAY_CAP_MS + REDIS_CONNECT_TIMEOUT_MS

/**
 * The backstop of the store that must converge without Redis: short, so the
 * test proves the mechanism, not `MAINTENANCE_MODE_RELOAD_INTERVAL_MS` itself.
 */
const SHORT_BACKSTOP_MS = 200

/**
 * The backstop of the store that must be reached by pub/sub after the
 * outage: longer than any wait here, so only a message or a reconnect moves it.
 */
const NEVER_MS = 600_000

const target = vi.hoisted(() => ({ realUrl: '', proxyUrl: '' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  target.realUrl = actual.getEnv().REDIS_URL
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), REDIS_URL: target.proxyUrl }),
  }
})

const proxy = new RedisProxy()
const stores: MaintenanceModeStore[] = []

/**
 * A started store, stopped after the test.
 * @param reloadIntervalMs - Its backstop interval.
 * @returns The store.
 */
async function startedStore(reloadIntervalMs: number): Promise<MaintenanceModeStore> {
  const store = createMaintenanceModeStore({ reloadIntervalMs })
  stores.push(store)
  await store.start()
  return store
}

beforeAll(async () => {
  await proxy.start(new URL(target.realUrl))
  target.proxyUrl = proxy.urlFor(new URL(target.realUrl))
  await resetMaintenanceMode()
})

afterEach(async () => {
  proxy.comeBack()
  await Promise.all(stores.map((store) => store.stop()))
  stores.length = 0
  await resetMaintenanceMode()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await closeRedis()
  proxy.close()
})

describe('maintenance-mode store through a Redis outage', () => {
  it('converges from Postgres on the backstop while Redis is down, then hears messages again once it returns', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const backstopped = await startedStore(SHORT_BACKSTOP_MS)
    const subscribed = await startedStore(NEVER_MS)
    // Both subscriptions are live before the outage: a published change reaches the long-backstop store.
    const warmUp = await storeMaintenanceMode('read_only')
    await waitUntil(
      async () => {
        await publishMaintenanceModeChange()
        return subscribed.get().version === warmUp
      },
      { message: 'the long-backstop store heard the warm-up message', interval: 200 }
    )

    proxy.goDown()
    const duringOutage = await storeMaintenanceMode('full', { message: 'Upgrading.' })
    await publishMaintenanceModeChange()

    await waitUntil(() => backstopped.get().version === duringOutage, {
      message: 'the backstop applied the change made while Redis was down',
    })
    expect(backstopped.get()).toMatchObject({ mode: 'full', message: 'Upgrading.' })

    proxy.comeBack()
    // The subscriber's reconnect reload brings the change it missed.
    await waitUntil(() => subscribed.get().version === duringOutage, {
      message: 'the long-backstop store reloaded on its subscriber reconnect',
      timeout: RECOVERY_TIMEOUT_MS,
    })
    await waitUntil(
      async () => {
        const client = await getRedis()
        return client.isReady
      },
      {
        message: 'the shared Redis client reconnected',
        timeout: RECOVERY_TIMEOUT_MS,
      }
    )
    const afterOutage = await storeMaintenanceMode('off')
    await publishMaintenanceModeChange()

    await waitUntil(() => subscribed.get().version === afterOutage, {
      message: 'pub/sub delivered the change made after Redis returned',
    })
    expect(subscribed.get().mode).toBe('off')
  })
})
