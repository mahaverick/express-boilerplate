// tests/unit/services/notification-emitter.service.test.ts
//
// Pure in-process pub/sub — no database, no HTTP, no Redis — so this is the
// one place the emitter's own contract (per-user isolation, multiple
// listeners, unsubscribe-by-reference, listenerCount) is proven directly,
// rather than only indirectly through
// tests/integration/api/notification-stream.test.ts's much heavier
// real-server, real-database SSE tests.
import { describe, expect, it } from 'vitest'
import type { Notification } from '@/database/models/notification.model'
import {
  emitNotification,
  listenerCount,
  offNotification,
  onNotification,
} from '@/services/notification-emitter.service'

/**
 * A minimal, valid-shaped `Notification` for these tests — only used as an
 * opaque payload the emitter must hand back unchanged, never inspected for
 * its own field values.
 * @param overrides - Fields to override on the default row.
 * @returns A fake notification row.
 */
function fakeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notification-1',
    userId: 'user-1',
    type: 'verify_email',
    title: 'Verify your email',
    body: 'body',
    // eslint-disable-next-line unicorn/no-null -- Notification.metadata/readAt are `T | null` database columns (notification.model.ts).
    metadata: null,
    // eslint-disable-next-line unicorn/no-null -- see comment above.
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

/**
 * A listener that does nothing — for tests (`listenerCount`'s own describe
 * block) that only care whether a handler is registered, never whether it
 * is actually called.
 */
function noopHandler(): void {
  // Intentionally empty.
}

describe('notification-emitter.service', () => {
  it('delivers an emitted notification to a subscribed listener', () => {
    const received: Notification[] = []
    const handler = (notification: Notification): void => {
      received.push(notification)
    }
    const notification = fakeNotification()

    onNotification('user-1', handler)
    try {
      emitNotification('user-1', notification)
      expect(received).toEqual([notification])
    } finally {
      offNotification('user-1', handler)
    }
  })

  it('never delivers one user’s notification to another user’s listener', () => {
    const receivedByOther: Notification[] = []
    const handler = (notification: Notification): void => {
      receivedByOther.push(notification)
    }

    onNotification('user-2', handler)
    try {
      emitNotification('user-1', fakeNotification({ userId: 'user-1' }))
      expect(receivedByOther).toEqual([])
    } finally {
      offNotification('user-2', handler)
    }
  })

  it('delivers to every listener subscribed for the same user', () => {
    const receivedA: Notification[] = []
    const receivedB: Notification[] = []
    const handlerA = (notification: Notification): void => {
      receivedA.push(notification)
    }
    const handlerB = (notification: Notification): void => {
      receivedB.push(notification)
    }
    const notification = fakeNotification()

    onNotification('user-3', handlerA)
    onNotification('user-3', handlerB)
    try {
      emitNotification('user-3', notification)
      expect(receivedA).toEqual([notification])
      expect(receivedB).toEqual([notification])
    } finally {
      offNotification('user-3', handlerA)
      offNotification('user-3', handlerB)
    }
  })

  it('is a no-op to emit for a user with no subscribed listener', () => {
    expect(() => emitNotification('user-with-no-listener', fakeNotification())).not.toThrow()
  })

  describe('listenerCount', () => {
    it('reports 0 for a user with no open connection', () => {
      expect(listenerCount('user-never-subscribed')).toBe(0)
    })

    it('tracks subscribe and unsubscribe', () => {
      expect(listenerCount('user-4')).toBe(0)
      onNotification('user-4', noopHandler)
      expect(listenerCount('user-4')).toBe(1)
      offNotification('user-4', noopHandler)
      expect(listenerCount('user-4')).toBe(0)
    })

    it('stops delivering once unsubscribed, even though emit itself never throws for a stale handler', () => {
      const received: Notification[] = []
      const handler = (notification: Notification): void => {
        received.push(notification)
      }

      onNotification('user-5', handler)
      offNotification('user-5', handler)
      emitNotification('user-5', fakeNotification())

      expect(received).toEqual([])
      expect(listenerCount('user-5')).toBe(0)
    })
  })
})
