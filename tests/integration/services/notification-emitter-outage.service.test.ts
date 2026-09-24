// tests/integration/services/notification-emitter-outage.service.test.ts
//
// Real Redis outages through a TCP proxy this file owns, never by stopping
// the shared Redis. Its own file because it mocks getEnv()'s REDIS_URL, as
// redis-outage.service.test.ts does.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Notification } from '@/database/models/notification.model'
import { countStreams, registerStream, resetLifecycleForTests } from '@/services/lifecycle.service'
import { logger } from '@/services/logger.service'
import {
  closeNotificationSubscriber,
  emitNotification,
  offNotification,
  onNotification,
} from '@/services/notification-emitter.service'
import { closeRedis, getRedis, isRedisReachable } from '@/services/redis.service'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  fakeNotification,
  waitForNotificationSubscriber,
} from '../../helpers/notification-subscriber'
import { isEventuallyTrue, RedisProxy, sleep } from '../../helpers/redis-proxy'

// Longer than the pre-ready fail-fast budget (~600ms), so only retry-forever survives it.
const OUTAGE_MS = 1500
const FAILED_TO_START = 'Notification subscriber failed to start'
const PUBLISH_FAILED =
  'Notification publish failed; delivering to this process only until Redis recovers'

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
const emitter = { onNotification, offNotification }

type LogMethod = (message: string, meta?: Record<string, unknown>) => void

function noopHandler(): void {
  // Intentionally empty.
}

describe('notification pub/sub survives a Redis outage', () => {
  beforeAll(async () => {
    await proxy.start(new URL(target.realUrl))
    target.proxyUrl = proxy.urlFor(new URL(target.realUrl))
  })

  // A failed test must not leave the next one on a dead proxy, or with its streams.
  afterEach(() => {
    proxy.comeBack()
    resetLifecycleForTests()
  })

  afterAll(async () => {
    await closeNotificationSubscriber()
    await closeRedis()
    proxy.close()
  })

  // First: needs a subscriber that has never been ready.
  it('gives up on a subscriber whose first connect fails, and replaces it on the next onNotification', async () => {
    const closer = vi.fn()
    registerStream(`stream-owner-${randomUUID()}`, closer)
    const logError = vi.fn<LogMethod>()

    await withMutatedMethod(logger, 'error', logError, async () => {
      proxy.goDown()
      const userId = `never-ready-${randomUUID()}`
      onNotification(userId, noopHandler)
      const hasGivenUp = await isEventuallyTrue(
        () => Promise.resolve(logError.mock.calls.some(([message]) => message === FAILED_TO_START)),
        5000
      )
      offNotification(userId, noopHandler)
      expect(hasGivenUp).toBe(true)
    })

    proxy.comeBack()
    await waitForNotificationSubscriber(emitter, getRedis)
    // A replacement's first ready is not a reconnect.
    expect(closer).not.toHaveBeenCalled()
  }, 15_000)

  it('delivers locally while the publish fails, warning once per outage', async () => {
    await waitForNotificationSubscriber(emitter, getRedis)
    const userId = `fallback-${randomUUID()}`
    const received: Notification[] = []
    const handler = (notification: Notification): void => {
      received.push(notification)
    }
    const first = fakeNotification({ userId })
    const second = fakeNotification({ userId })
    const third = fakeNotification({ userId })
    const fourth = fakeNotification({ userId })
    const logWarn = vi.fn<LogMethod>()
    const publishWarnings = (): number =>
      logWarn.mock.calls.filter(([message]) => message === PUBLISH_FAILED).length
    const hasReceived = async (count: number): Promise<boolean> =>
      isEventuallyTrue(() => Promise.resolve(received.length >= count), 5000)

    onNotification(userId, handler)
    try {
      await withMutatedMethod(logger, 'warn', logWarn, async () => {
        proxy.goDown()
        await sleep(100)
        emitNotification(userId, first)
        emitNotification(userId, second)
        expect(await hasReceived(2)).toBe(true)
        expect(received).toHaveLength(2)
        expect(received).toEqual(expect.arrayContaining([first, second]))
        expect(publishWarnings()).toBe(1)

        proxy.comeBack()
        expect(await isEventuallyTrue(isRedisReachable, 8000)).toBe(true)
        await waitForNotificationSubscriber(emitter, getRedis)
        emitNotification(userId, third)
        expect(await hasReceived(3)).toBe(true)
        // Through the subscriber only: a successful publish is not also delivered locally.
        await sleep(200)
        expect(received).toHaveLength(3)

        proxy.goDown()
        await sleep(100)
        emitNotification(userId, fourth)
        expect(await hasReceived(4)).toBe(true)
        expect(publishWarnings()).toBe(2)
      })
    } finally {
      offNotification(userId, handler)
    }
  }, 30_000)

  it('closes every open stream once the subscriber reconnects after an outage, then delivers live again', async () => {
    await waitForNotificationSubscriber(emitter, getRedis)
    const owner = `stream-owner-${randomUUID()}`
    const closer = vi.fn()
    registerStream(owner, closer)

    proxy.goDown()
    await sleep(OUTAGE_MS)
    expect(closer).not.toHaveBeenCalled()
    proxy.comeBack()

    const hasClosed = await isEventuallyTrue(
      () => Promise.resolve(closer.mock.calls.length > 0),
      8000
    )
    expect(hasClosed).toBe(true)
    expect(closer).toHaveBeenCalledTimes(1)
    expect(countStreams(owner)).toBe(0)
    await waitForNotificationSubscriber(emitter, getRedis)
  }, 20_000)
})
