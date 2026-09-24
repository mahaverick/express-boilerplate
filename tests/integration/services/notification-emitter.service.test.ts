// tests/integration/services/notification-emitter.service.test.ts
//
// Delivery runs through the real Redis, on this worker's own channel
// (QUEUE_PREFIX is per vitest worker). A second module graph, loaded after
// vi.resetModules(), stands in for another replica with its own clients,
// subscriber and EventEmitter. That graph never reaches database.service.ts
// (the model import is type-only), so no extra Postgres pool is opened.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Notification } from '@/database/models/notification.model'
import * as replicaA from '@/services/notification-emitter.service'
import * as redisA from '@/services/redis.service'
import {
  countSubscribers,
  fakeNotification,
  notificationChannel,
  waitForNotificationSubscriber,
} from '../../helpers/notification-subscriber'
import { isEventuallyTrue, sleep } from '../../helpers/redis-proxy'

interface Replica {
  emitter: typeof replicaA
  redis: typeof redisA
}

const replicas: { b: Replica | undefined } = { b: undefined }

function replicaB(): Replica {
  if (!replicas.b) throw new Error('replica B is loaded in beforeAll')
  return replicas.b
}

function collector(): {
  received: Notification[]
  handler: (notification: Notification) => void
} {
  const received: Notification[] = []
  return {
    received,
    handler: (notification) => {
      received.push(notification)
    },
  }
}

/**
 * How many TCP sockets this process holds open.
 * @returns The count of open TCP socket handles.
 */
function openSocketCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'TCPSocketWrap').length
}

function noopHandler(): void {
  // Intentionally empty.
}

function throwingHandler(): void {
  throw new Error('a listener blew up')
}

async function hasReceived(received: Notification[], count: number): Promise<boolean> {
  return isEventuallyTrue(() => Promise.resolve(received.length >= count), 5000)
}

describe('notification-emitter.service', () => {
  beforeAll(async () => {
    vi.resetModules()
    replicas.b = {
      emitter: await import('@/services/notification-emitter.service'),
      redis: await import('@/services/redis.service'),
    }
  })

  afterAll(async () => {
    const b = replicaB()
    await Promise.all([
      replicaA.closeNotificationSubscriber(),
      b.emitter.closeNotificationSubscriber(),
    ])
    await Promise.all([redisA.closeRedis(), b.redis.closeRedis()])
  })

  // First: needs replica A before anything has subscribed on it.
  it('opens no subscriber for a process that only publishes, and one on the first onNotification', async () => {
    const client = await redisA.getRedis()
    const before = await countSubscribers(client)

    replicaA.emitNotification(`publisher-only-${randomUUID()}`, fakeNotification())
    await sleep(200)
    expect(await countSubscribers(client)).toBe(before)

    const userId = `first-listener-${randomUUID()}`
    replicaA.onNotification(userId, noopHandler)
    try {
      const hasSubscribed = await isEventuallyTrue(
        async () => (await countSubscribers(client)) === before + 1,
        5000
      )
      expect(hasSubscribed).toBe(true)
    } finally {
      replicaA.offNotification(userId, noopHandler)
    }
  })

  it('delivers a notification emitted on one replica to a listener on another, with its dates revived', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const userId = `cross-${randomUUID()}`
    const { received, handler } = collector()
    const notification = fakeNotification({
      userId,
      readAt: new Date('2026-02-01T10:00:00.000Z'),
    })

    replicaA.onNotification(userId, handler)
    try {
      replicaB().emitter.emitNotification(userId, notification)
      expect(await hasReceived(received, 1)).toBe(true)
      expect(received).toEqual([notification])
      expect(received[0]?.createdAt).toBeInstanceOf(Date)
      expect(received[0]?.readAt).toBeInstanceOf(Date)
    } finally {
      replicaA.offNotification(userId, handler)
    }
  })

  it('delivers exactly once on the publishing replica as well as on the other', async () => {
    const b = replicaB()
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    await waitForNotificationSubscriber(b.emitter, b.redis.getRedis)
    const userId = `both-${randomUUID()}`
    const onA = collector()
    const onB = collector()

    replicaA.onNotification(userId, onA.handler)
    b.emitter.onNotification(userId, onB.handler)
    try {
      b.emitter.emitNotification(userId, fakeNotification({ userId }))
      expect(await hasReceived(onA.received, 1)).toBe(true)
      expect(await hasReceived(onB.received, 1)).toBe(true)
      // An upper bound has no event to wait for; settle, then count.
      await sleep(200)
      expect(onA.received).toHaveLength(1)
      expect(onB.received).toHaveLength(1)
    } finally {
      replicaA.offNotification(userId, onA.handler)
      b.emitter.offNotification(userId, onB.handler)
    }
  })

  it('never delivers one user’s notification to another user’s listener', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const owner = `owner-${randomUUID()}`
    const other = `other-${randomUUID()}`
    const onOwner = collector()
    const onOther = collector()

    replicaA.onNotification(owner, onOwner.handler)
    replicaA.onNotification(other, onOther.handler)
    try {
      replicaA.emitNotification(owner, fakeNotification({ userId: owner }))
      expect(await hasReceived(onOwner.received, 1)).toBe(true)
      await sleep(100)
      expect(onOther.received).toEqual([])
    } finally {
      replicaA.offNotification(owner, onOwner.handler)
      replicaA.offNotification(other, onOther.handler)
    }
  })

  it('delivers to every listener subscribed for the same user', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const userId = `many-${randomUUID()}`
    const first = collector()
    const second = collector()
    const notification = fakeNotification({ userId })

    replicaA.onNotification(userId, first.handler)
    replicaA.onNotification(userId, second.handler)
    try {
      replicaA.emitNotification(userId, notification)
      expect(await hasReceived(first.received, 1)).toBe(true)
      expect(await hasReceived(second.received, 1)).toBe(true)
      expect(first.received).toEqual([notification])
      expect(second.received).toEqual([notification])
    } finally {
      replicaA.offNotification(userId, first.handler)
      replicaA.offNotification(userId, second.handler)
    }
  })

  describe('listenerCount', () => {
    it('reports 0 for a user with no open connection', () => {
      expect(replicaA.listenerCount(`never-${randomUUID()}`)).toBe(0)
    })

    it('tracks subscribe and unsubscribe', () => {
      const userId = `count-${randomUUID()}`
      replicaA.onNotification(userId, noopHandler)
      expect(replicaA.listenerCount(userId)).toBe(1)
      replicaA.offNotification(userId, noopHandler)
      expect(replicaA.listenerCount(userId)).toBe(0)
    })

    it('stops delivering once unsubscribed', async () => {
      await waitForNotificationSubscriber(replicaA, redisA.getRedis)
      const userId = `unsubscribed-${randomUUID()}`
      const { received, handler } = collector()

      replicaA.onNotification(userId, handler)
      replicaA.offNotification(userId, handler)
      replicaA.emitNotification(userId, fakeNotification({ userId }))
      await sleep(200)

      expect(received).toEqual([])
      expect(replicaA.listenerCount(userId)).toBe(0)
    })
  })

  it('drops malformed messages without throwing, and keeps delivering', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const userId = `malformed-${randomUUID()}`
    const { received, handler } = collector()
    const valid = fakeNotification({ userId })
    const client = await redisA.getRedis()
    const channel = notificationChannel()

    replicaA.onNotification(userId, handler)
    try {
      await client.publish(channel, 'not json')
      await client.publish(channel, JSON.stringify({ userId }))
      await client.publish(
        channel,
        JSON.stringify({ userId, notification: { ...valid, createdAt: 'yesterday' } })
      )
      await client.publish(
        channel,
        JSON.stringify({ userId, notification: { ...valid, type: 'not_a_type' } })
      )
      await client.publish(channel, JSON.stringify({ userId, notification: valid }))

      expect(await hasReceived(received, 1)).toBe(true)
      // One publishing connection keeps order, so the malformed ones were handled first.
      expect(received).toEqual([valid])
    } finally {
      replicaA.offNotification(userId, handler)
    }
  })

  it('keeps delivering after a listener throws', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const throwingUser = `throws-${randomUUID()}`
    const healthyUser = `healthy-${randomUUID()}`
    const { received, handler } = collector()

    replicaA.onNotification(throwingUser, throwingHandler)
    replicaA.onNotification(healthyUser, handler)
    try {
      replicaA.emitNotification(throwingUser, fakeNotification({ userId: throwingUser }))
      replicaA.emitNotification(healthyUser, fakeNotification({ userId: healthyUser }))
      expect(await hasReceived(received, 1)).toBe(true)
    } finally {
      replicaA.offNotification(throwingUser, throwingHandler)
      replicaA.offNotification(healthyUser, handler)
    }
  })

  it('still delivers to a user’s other listeners when one of them throws', async () => {
    await waitForNotificationSubscriber(replicaA, redisA.getRedis)
    const userId = `throws-first-${randomUUID()}`
    const { received, handler } = collector()

    replicaA.onNotification(userId, throwingHandler)
    replicaA.onNotification(userId, handler)
    try {
      replicaA.emitNotification(userId, fakeNotification({ userId }))
      expect(await hasReceived(received, 1)).toBe(true)
    } finally {
      replicaA.offNotification(userId, throwingHandler)
      replicaA.offNotification(userId, handler)
    }
  })

  it('leaves no subscriber behind when closed in the same tick as its first onNotification', async () => {
    // A third replica: this one's subscriber is still opening its socket when closed.
    vi.resetModules()
    const c = {
      emitter: await import('@/services/notification-emitter.service'),
      redis: await import('@/services/redis.service'),
    }
    const client = await redisA.getRedis()
    const before = await countSubscribers(client)
    const socketsBefore = openSocketCount()
    const userId = `same-tick-close-${randomUUID()}`

    c.emitter.onNotification(userId, noopHandler)
    try {
      await c.emitter.closeNotificationSubscriber()
      // An upper bound has no event to wait for; settle, then count.
      await sleep(300)
      expect(await countSubscribers(client)).toBe(before)
      expect(openSocketCount()).toBe(socketsBefore)
    } finally {
      c.emitter.offNotification(userId, noopHandler)
      await c.redis.closeRedis()
    }
  })

  // Last: closing is final for replica B.
  it('closeNotificationSubscriber closes the subscriber, is safe twice, and is never reopened', async () => {
    const b = replicaB()
    await waitForNotificationSubscriber(b.emitter, b.redis.getRedis)
    const client = await redisA.getRedis()
    const before = await countSubscribers(client)

    await b.emitter.closeNotificationSubscriber()
    const hasClosed = await isEventuallyTrue(
      async () => (await countSubscribers(client)) === before - 1,
      5000
    )
    expect(hasClosed).toBe(true)
    await expect(b.emitter.closeNotificationSubscriber()).resolves.toBeUndefined()

    const userId = `after-close-${randomUUID()}`
    b.emitter.onNotification(userId, noopHandler)
    try {
      await sleep(200)
      expect(await countSubscribers(client)).toBe(before - 1)
    } finally {
      b.emitter.offNotification(userId, noopHandler)
    }
  })
})
