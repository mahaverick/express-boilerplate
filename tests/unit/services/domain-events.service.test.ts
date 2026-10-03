/**
 * @file The domain-event seam: every subscriber of a type runs, in order,
 * with the emitter's access; a subscriber that throws or rejects is logged
 * and neither fails the emit nor stops the next one; subscribing a function
 * twice runs it once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitDomainEvent,
  resetDomainEventSubscribers,
  subscribeDomainEvent,
} from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import type { DomainEvent, DomainEventContext } from '@/types/domain-event'

const event: DomainEvent = {
  type: 'teammate_invited',
  tenantId: 'tenant-1',
  actorId: 'user-1',
  at: new Date('2026-10-02T09:00:00.000Z'),
}

afterEach(() => {
  resetDomainEventSubscribers()
  vi.restoreAllMocks()
})

describe('emitDomainEvent', () => {
  it('runs every subscriber of the type in order, with member access by default', async () => {
    const calls: string[] = []
    subscribeDomainEvent('teammate_invited', (received, context) => {
      calls.push(`first:${received.tenantId}:${context.access}`)
    })
    subscribeDomainEvent('teammate_invited', async (_received, context) => {
      await Promise.resolve()
      calls.push(`second:${context.access}`)
    })
    subscribeDomainEvent('tenant_settings_updated', () => {
      calls.push('other type')
    })

    await emitDomainEvent(event)

    expect(calls).toEqual(['first:tenant-1:member', 'second:member'])
  })

  it('passes the access the emitter names', async () => {
    const contexts: DomainEventContext[] = []
    subscribeDomainEvent('teammate_invited', (_received, context) => {
      contexts.push(context)
    })

    await emitDomainEvent(event, { access: 'platform' })

    expect(contexts).toEqual([{ access: 'platform' }])
  })

  it('logs a throwing or rejecting subscriber and still runs the next, never rejecting', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const reached: string[] = []
    subscribeDomainEvent('teammate_invited', () => {
      throw new Error('sync failure')
    })
    subscribeDomainEvent('teammate_invited', () => Promise.reject(new Error('async failure')))
    subscribeDomainEvent('teammate_invited', () => {
      reached.push('last')
    })

    await expect(emitDomainEvent(event)).resolves.toBeUndefined()

    expect(reached).toEqual(['last'])
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      'Domain event subscriber failed',
      expect.objectContaining({ eventType: 'teammate_invited', tenantId: 'tenant-1' })
    )
  })

  it('logs the user instead of a tenant for a user-level event', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    subscribeDomainEvent('user_signed_in', () => {
      throw new Error('sync failure')
    })

    await emitDomainEvent({
      type: 'user_signed_in',
      userId: 'user-9',
      method: 'password',
      at: new Date('2026-10-02T09:00:00.000Z'),
    })

    const meta = error.mock.calls[0]?.[1]
    expect(meta).toMatchObject({ eventType: 'user_signed_in', userId: 'user-9' })
    expect(meta).not.toHaveProperty('tenantId')
  })

  it('runs a function subscribed twice once', async () => {
    const handler = vi.fn()
    subscribeDomainEvent('teammate_invited', handler)
    subscribeDomainEvent('teammate_invited', handler)

    await emitDomainEvent(event)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('reaches no subscriber after a reset', async () => {
    const handler = vi.fn()
    subscribeDomainEvent('teammate_invited', handler)
    resetDomainEventSubscribers()

    await emitDomainEvent(event)

    expect(handler).not.toHaveBeenCalled()
  })
})
