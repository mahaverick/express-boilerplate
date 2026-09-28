/**
 * @file Real Redis outages through a TCP proxy this file owns, never by
 * stopping the shared Redis. Its own file because it mocks `getEnv()`'s
 * `REDIS_URL`, as `redis-outage.service.test.ts` does.
 *
 * The `MUTATION_PROOF` test is DELIBERATELY red: it drops the emitter's
 * `'error'` listener, the only thing that destroys a subscriber closed
 * while its reconnect is refused.
 *
 * ```
 * MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/notification-emitter-outage.service.test.ts   # red
 * ```
 */
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
import {
  closeRedis,
  createRedisClient,
  getRedis,
  isRedisReachable,
  RECONNECT_DELAY_CAP_MS,
  REDIS_CONNECT_TIMEOUT_MS,
} from '@/services/redis.service'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'
import {
  countSubscribers,
  fakeNotification,
  waitForNotificationSubscriber,
} from '../../helpers/notification-subscriber'
import { isEventuallyTrue, RedisProxy } from '../../helpers/redis-proxy'
import { settle, waitUntil } from '../../helpers/timing'

// Longer than the pre-ready fail-fast budget (~600ms), so only retry-forever survives it.
const OUTAGE_MS = 1500
// Longer than the subscriber's first retry delay (1s).
const RETRY_SETTLE_MS = 2000
// One capped retry delay, then one connect attempt.
const RECOVERY_TIMEOUT_MS = RECONNECT_DELAY_CAP_MS + REDIS_CONNECT_TIMEOUT_MS
// The close claim: prompt, never stuck behind the retry backoff. 10x the whole test's measured p99 (399ms).
const PROMPT_CLOSE_BUDGET_MS = 4000
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
 * @param decorate - Applied to each client before the fresh module sees it.
 * @returns Resolves once `run` settles.
 */
async function withFreshEmitter(
  run: (fresh: EmitterModule, clients: RedisClientType[]) => Promise<void>,
  decorate: (client: RedisClientType) => RedisClientType = (client) => client
): Promise<void> {
  const clients: RedisClientType[] = []
  const createCapturedClient = (): RedisClientType => {
    const client = decorate(createRedisClient())
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
 * Whether the shared Redis client has seen the proxy reset its connection.
 * @returns True once that client is no longer ready.
 */
async function hasRedisClientLeftReady(): Promise<boolean> {
  const client = await getRedis()
  return !client.isReady
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

/**
 * Drop any `'error'` listener registered through `client.on` from here on;
 * its existing logger listener stays. Only intercepts `.on` — a listener
 * added via `.addListener` or `.prependListener` would not be caught
 * (`.once` routes through `.on` and is caught).
 * @param client - A client `createRedisClient` just built.
 * @returns The same client.
 */
function withoutLaterErrorListeners(client: RedisClientType): RedisClientType {
  const on = client.on.bind(client)
  client.on = ((event: string | symbol, listener: (...listenerArguments: unknown[]) => void) =>
    event === 'error' ? client : on(event, listener)) as RedisClientType['on']
  return client
}

/**
 * Close a live fresh subscriber as its reconnect starts, while nothing listens
 * on its port, and check it leaves nothing behind.
 * @param decorate - Applied to each client the fresh emitter creates.
 * @returns Resolves once every check has passed.
 */
async function expectRefusedReconnectCloseLeavesNothing(
  decorate: (client: RedisClientType) => RedisClientType
): Promise<void> {
  const counter: RedisClientType = createClient({ url: target.realUrl })
  await counter.connect()
  // Its own proxy: close() stops it listening, so the reconnect is refused before it has a socket.
  const refusing = new RedisProxy()
  await refusing.start(new URL(target.realUrl))
  const mainProxyUrl = target.proxyUrl
  try {
    await withFreshEmitter(async (fresh, clients) => {
      const userId = `refused-reconnect-close-${randomUUID()}`
      await waitForNotificationSubscriber(emitter, getRedis)
      const before = await countSubscribers(counter)
      target.proxyUrl = refusing.urlFor(new URL(target.realUrl))
      try {
        fresh.onNotification(userId, noopHandler)
      } finally {
        target.proxyUrl = mainProxyUrl
      }
      const [subscriber] = clients
      try {
        if (!subscriber) throw new Error('the fresh emitter created no subscriber')
        await waitForNotificationSubscriber(fresh, getRedis)
        const closing = new Promise<void>((resolve) => {
          subscriber.once('reconnecting', () => {
            void fresh.closeNotificationSubscriber().then(resolve)
          })
        })
        refusing.close()
        await closing
        await waitUntil(() => !subscriber.isOpen, {
          message: 'the closed subscriber is still reconnecting',
        })
        await waitUntil(async () => (await countSubscribers(counter)) === before, {
          message: 'Redis still counts the closed subscriber',
        })
        expect(clients).toHaveLength(1)
      } finally {
        fresh.offNotification(userId, noopHandler)
        // Only the mutation leaves it open; left alone it would retry for the rest of the file.
        if (subscriber?.isOpen) subscriber.destroy()
      }
    }, decorate)
  } finally {
    refusing.close()
    await counter.close()
  }
}

describe('notification pub/sub survives a Redis outage', () => {
  beforeAll(async () => {
    await proxy.start(new URL(target.realUrl))
    target.proxyUrl = proxy.urlFor(new URL(target.realUrl))
  })

  /**
   * A test can end, passed or failed, on a dead proxy, with its streams
   * still open, or behind a reconnect its outage started.
   */
  afterEach(async () => {
    proxy.comeBack()
    resetLifecycleForTests()
    await waitForNotificationSubscriber(emitter, getRedis, RECOVERY_TIMEOUT_MS)
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
        await waitUntil(hasRedisClientLeftReady, {
          message: 'the shared Redis client sees the outage',
        })
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
        await settle(200, 'absence has no event: a local copy would arrive within it')
        expect(received).toHaveLength(3)

        proxy.goDown()
        await waitUntil(hasRedisClientLeftReady, {
          message: 'the shared Redis client sees the second outage',
        })
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
    await settle(OUTAGE_MS, 'outage length; no closer may run while Redis is down')
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
      const [subscriber] = clients
      if (!subscriber) throw new Error('the fresh emitter created no subscriber')
      const attempts = { reconnects: 0, hasSecondFailed: false }
      const onReconnecting = (): void => {
        attempts.reconnects += 1
      }
      const onError = (): void => {
        if (attempts.reconnects >= 1) attempts.hasSecondFailed = true
      }
      subscriber.on('reconnecting', onReconnecting)
      subscriber.on('error', onError)
      try {
        /**
         * The first retry has no delay; once the second attempt fails, the
         * client waits in the next retry's backoff (100ms) before its third
         * attempt.
         */
        await waitUntil(() => attempts.hasSecondFailed, {
          message: "the fresh subscriber's second connect attempt fails",
        })
      } finally {
        subscriber.off('reconnecting', onReconnecting)
        subscriber.off('error', onError)
      }
      try {
        const close = async (): Promise<'closed'> => {
          await fresh.closeNotificationSubscriber()
          return 'closed'
        }
        const giveUp = async (): Promise<'timed out'> => {
          await settle(
            PROMPT_CLOSE_BUDGET_MS,
            'race budget: a close stuck in the backoff never settles'
          )
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
          await settle(500, 'absence has no event: a subscriber left behind would show within it')
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

  it('leaves no subscriber behind when closed as a reconnect starts and Redis stays unreachable', async () => {
    await expectRefusedReconnectCloseLeavesNothing((client) => client)
  }, 15_000)

  // DELIBERATELY red under MUTATION_PROOF=1.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the unreachable-reconnect close against a subscriber whose error listener is gone',
    async () => {
      await expectRefusedReconnectCloseLeavesNothing(withoutLaterErrorListeners)
    },
    15_000
  )

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
          await settle(
            RETRY_SETTLE_MS,
            "absence has no event: a retry would start within the first retry's delay"
          )
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
        await settle(
          RETRY_SETTLE_MS,
          "absence has no event: a retry would start within the first retry's delay"
        )
        expect(clients).toHaveLength(1)
        await fresh.closeNotificationSubscriber()
      })
    }, 15_000)
  })
})
