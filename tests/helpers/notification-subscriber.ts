// tests/helpers/notification-subscriber.ts
//
// The notification subscriber connects lazily and asynchronously, while
// onNotification stays synchronous. A test that emits right after its first
// onNotification could publish before SUBSCRIBE lands; these helpers wait
// until this process's subscriber provably receives.
import { randomUUID } from 'node:crypto'
import type { RedisClientType } from 'redis'
import { getEnv } from '@/configs/env.config'
import type { Notification } from '@/database/models/notification.model'
import { sleep } from './redis-proxy'

type EmitterModule = typeof import('@/services/notification-emitter.service')

/**
 * A valid notification row for tests; nothing here is persisted.
 * @param overrides - Fields to override on the default row.
 * @returns A fake notification row.
 */
export function fakeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: randomUUID(),
    userId: 'user-1',
    type: 'verify_email',
    title: 'Verify your email',
    body: 'body',
    // eslint-disable-next-line unicorn/no-null -- Notification.metadata/readAt/dedupeKey are `T | null` columns.
    metadata: null,
    // eslint-disable-next-line unicorn/no-null -- see above.
    readAt: null,
    // eslint-disable-next-line unicorn/no-null -- see above.
    dedupeKey: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

/**
 * The channel this worker's notifications travel on.
 * @returns `${QUEUE_PREFIX}:notifications`.
 */
export function notificationChannel(): string {
  return `${getEnv().QUEUE_PREFIX}:notifications`
}

/**
 * How many connections Redis reports subscribed to this worker's channel.
 * @param client - Any connected, non-subscriber client.
 * @returns The subscriber count.
 */
export async function countSubscribers(client: RedisClientType): Promise<number> {
  const channel = notificationChannel()
  const counts = await client.pubSubNumSub(channel)
  return Number(counts[channel] ?? 0)
}

/**
 * Wait until this process's subscriber hands back a probe published straight to Redis.
 * @param emitter - The emitter module instance under test.
 * @param getRedis - The same module graph's `getRedis`, used to publish the probe.
 * @param timeoutMs - How long to keep probing.
 * @returns Resolves once the probe arrives.
 * @throws {Error} When no probe arrives within `timeoutMs`.
 */
export async function waitForNotificationSubscriber(
  emitter: Pick<EmitterModule, 'onNotification' | 'offNotification'>,
  getRedis: () => Promise<RedisClientType>,
  timeoutMs = 5000
): Promise<void> {
  const probeUserId = `subscriber-probe-${randomUUID()}`
  const probe = { received: false }
  const handler = (): void => {
    probe.received = true
  }
  const message = JSON.stringify({
    userId: probeUserId,
    notification: fakeNotification({ userId: probeUserId }),
  })
  emitter.onNotification(probeUserId, handler)
  try {
    const deadline = Date.now() + timeoutMs
    while (!probe.received) {
      if (Date.now() > deadline) {
        throw new Error(`Notification subscriber not live within ${timeoutMs}ms`)
      }
      try {
        const client = await getRedis()
        await client.publish(notificationChannel(), message)
      } catch {
        // Redis is still coming back; probe again.
      }
      await sleep(50)
    }
  } finally {
    emitter.offNotification(probeUserId, handler)
  }
}
