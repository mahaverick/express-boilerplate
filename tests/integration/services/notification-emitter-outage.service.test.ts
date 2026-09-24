// tests/integration/services/notification-emitter-outage.service.test.ts
//
// Real Redis outages through a TCP proxy this file owns, never by stopping
// the shared Redis. Its own file because it mocks getEnv()'s REDIS_URL, as
// redis-outage.service.test.ts does.
import { randomUUID } from 'node:crypto'
import { createClient, type RedisClientType } from 'redis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Notification } from '@/database/models/notification.model'
import { countStreams, registerStream, resetLifecycleForTests } from '@/services/lifecycle.service'
import * as loggerModule from '@/services/logger.service'
import { logger } from '@/services/logger.service'
import {
  closeNotificationSubscriber,
  emitNotification,
  offNotification,
  onNotification,
} from '@/services/notification-emitter.service'
import { closeRedis, createRedisClient, getRedis, isRedisReachable } from '@/services/redis.service'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'
import {
  countSubscribers,
  fakeNotification,
  waitForNotificationSubscriber,
} from '../../helpers/notification-subscriber'
import { isEventuallyTrue, RedisProxy, sleep } from '../../helpers/redis-proxy'

// Longer than the pre-ready fail-fast budget (~600ms), so only retry-forever survives it.
const OUTAGE_MS = 1500
// Longer than the subscriber's first retry delay (1s).
const RETRY_SETTLE_MS = 2000
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

type EmitterModule = typeof import('@/services/notification-emitter.service')

function noopHandler(): void {
  // Intentionally empty.
}

/**
 * Run against a fresh emitter module, whose subscriber has never been opened.
 * @param run - Gets the fresh module and every Redis client it created.
 * @returns Resolves once `run` settles.
 */
async function withFreshEmitter(
  run: (fresh: EmitterModule, clients: RedisClientType[]) => Promise<void>
): Promise<void> {
  const clients: RedisClientType[] = []
  const createCapturedClient = (): RedisClientType => {
    const client = createRedisClient()
    clients.push(client)
    return client
  }
  // Share this file's logger: each fresh one adds a 'close' listener to stdout.
  vi.doMock('@/services/logger.service', () => loggerModule)
  try {
    await withMutatedModule(
      '@/services/redis.service',
      { createRedisClient: createCapturedClient },
      () => import('@/services/notification-emitter.service'),
      (fresh) => run(fresh, clients)
    )
  } finally {
    vi.doUnmock('@/services/logger.service')
  }
}

/**
 * Wait until a fresh emitter's first subscriber has given up.
 * @param clients - The clients the fresh emitter created.
 * @returns Whether it gave up within the budget.
 */
async function hasFirstAttemptFailed(clients: RedisClientType[]): Promise<boolean> {
  return isEventuallyTrue(
    () => Promise.resolve(clients[0] !== undefined && !clients[0].isOpen),
    5000
  )
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

  it('closes promptly when shutdown lands in a first connect’s retry backoff', async () => {
    await withFreshEmitter(async (fresh, clients) => {
      const userId = `backoff-close-${randomUUID()}`
      proxy.goDown()
      fresh.onNotification(userId, noopHandler)
      // Inside the fail-fast retries: the first attempt was reset, the next is still waiting.
      await sleep(150)
      try {
        const close = async (): Promise<'closed'> => {
          await fresh.closeNotificationSubscriber()
          return 'closed'
        }
        const giveUp = async (): Promise<'timed out'> => {
          await sleep(3000)
          return 'timed out'
        }
        const winner = await Promise.race([close(), giveUp()])
        expect(winner).toBe('closed')
        expect(clients[0]?.isOpen).toBe(false)
      } finally {
        fresh.offNotification(userId, noopHandler)
      }
    })
  }, 10_000)

  it('leaves no subscriber behind when closed as a reconnect starts opening its socket', async () => {
    const counter: RedisClientType = createClient({ url: target.realUrl })
    await counter.connect()
    try {
      await withFreshEmitter(async (fresh, clients) => {
        const userId = `reconnect-close-${randomUUID()}`
        // This file's own subscriber counts too, so it must be live at both counts.
        await waitForNotificationSubscriber(emitter, getRedis)
        const before = await countSubscribers(counter)
        fresh.onNotification(userId, noopHandler)
        try {
          await waitForNotificationSubscriber(fresh, getRedis)
          const [subscriber] = clients
          if (!subscriber) throw new Error('the fresh emitter created no subscriber')

          const closing = new Promise<void>((resolve) => {
            subscriber.once('reconnecting', () => {
              // Redis is back before this reconnect opens its socket.
              proxy.comeBack()
              void fresh.closeNotificationSubscriber().then(resolve)
            })
          })
          proxy.goDown()
          await closing
          // An upper bound has no event to wait for; settle, then count.
          await sleep(500)
          await waitForNotificationSubscriber(emitter, getRedis)
          expect(await countSubscribers(counter)).toBe(before)
          expect(subscriber.isOpen).toBe(false)
        } finally {
          fresh.offNotification(userId, noopHandler)
        }
      })
    } finally {
      await counter.close()
    }
  }, 15_000)

  describe('a first connect that fails while a listener waits', () => {
    it('is retried once Redis is back, and closes the open streams so they replay', async () => {
      await withFreshEmitter(async (fresh, clients) => {
        const lifecycle = await import('@/services/lifecycle.service')
        const closer = vi.fn()
        lifecycle.registerStream(`stream-owner-${randomUUID()}`, closer)
        const userId = `retried-${randomUUID()}`

        proxy.goDown()
        fresh.onNotification(userId, noopHandler)
        try {
          expect(await hasFirstAttemptFailed(clients)).toBe(true)
          // No storm: a failed attempt closes nothing.
          expect(closer).not.toHaveBeenCalled()
          proxy.comeBack()

          const hasClosed = await isEventuallyTrue(
            () => Promise.resolve(closer.mock.calls.length > 0),
            10_000
          )
          expect(hasClosed).toBe(true)
          expect(closer).toHaveBeenCalledTimes(1)
          await waitForNotificationSubscriber(fresh, getRedis)
          expect(clients).toHaveLength(2)
        } finally {
          fresh.offNotification(userId, noopHandler)
          await fresh.closeNotificationSubscriber()
        }
      })
    }, 20_000)

    it('is not retried after closeNotificationSubscriber', async () => {
      await withFreshEmitter(async (fresh, clients) => {
        const userId = `closed-before-retry-${randomUUID()}`
        proxy.goDown()
        fresh.onNotification(userId, noopHandler)
        try {
          expect(await hasFirstAttemptFailed(clients)).toBe(true)
          await fresh.closeNotificationSubscriber()
          proxy.comeBack()
          // Past the first retry's delay; an upper bound has no event to wait for.
          await sleep(RETRY_SETTLE_MS)
          expect(clients).toHaveLength(1)
        } finally {
          fresh.offNotification(userId, noopHandler)
        }
      })
    }, 15_000)

    it('is not retried once its last listener is gone', async () => {
      await withFreshEmitter(async (fresh, clients) => {
        const userId = `left-before-retry-${randomUUID()}`
        proxy.goDown()
        fresh.onNotification(userId, noopHandler)
        try {
          expect(await hasFirstAttemptFailed(clients)).toBe(true)
        } finally {
          fresh.offNotification(userId, noopHandler)
        }
        proxy.comeBack()
        await sleep(RETRY_SETTLE_MS)
        expect(clients).toHaveLength(1)
        await fresh.closeNotificationSubscriber()
      })
    }, 15_000)
  })
})
