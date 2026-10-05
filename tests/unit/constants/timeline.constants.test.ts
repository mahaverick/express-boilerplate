/**
 * @file TIMELINE_PROP_KEYS against what the server actually sends PostHog:
 * every property key the analytics builder emits on an event a timeline can
 * list is either allowlisted, read into a row field of its own, or excluded
 * here on purpose with a reason. A new builder key fails this test until it
 * is classified. Also pins the range hours and the excluded events.
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { PRODUCT_EVENTS } from '@/constants/analytics.constants'
import { AUDIT_ACTION_NAMES, AUDIT_ACTIONS, type AuditAction } from '@/constants/audit.constants'
import { EMAIL_EVENT_TYPES } from '@/constants/email.constants'
import {
  TIMELINE_EXCLUDED_EVENTS,
  TIMELINE_PROP_KEYS,
  TIMELINE_RANGE_HOURS,
} from '@/constants/timeline.constants'
import type { AuditLog } from '@/database/models/audit-log.model'
import {
  buildAuditEvents,
  buildEmailEvent,
  buildProductEvent,
} from '@/services/analytics/analytics-event-builder.service'
import { TENANT_INVITATION_TEMPLATE_KEY } from '@/templates/email/tenant-invitation.template'
import type { ProductDomainEvent } from '@/types/domain-event'

const AT = new Date('2026-10-04T10:00:00.000Z')
const USER_ID = '0199a1b2-0000-7000-8000-000000000001'
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000002'
const CONTEXT = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), posthogSessionId: 'session' }

/**
 * Builder keys a row reads into a field of its own rather than `props`.
 */
const ROW_FIELD_KEYS = ['source', 'access', 'app', 'trace_id', '$session_id'] as const

/**
 * Builder keys no timeline row carries, and why.
 */
const DELIBERATELY_EXCLUDED: Readonly<Record<string, string>> = {
  span_id: 'the trace id already links the row to its request',
  $groups: 'the tenant timeline is selected by group; the row needs no copy',
  $process_person_profile: 'PostHog bookkeeping',
  $set: 'person properties, not part of the event',
  $set_once: 'person properties, not part of the event',
  changed: 'a list of field names, not a scalar',
  user_id: 'another user’s id; the row links its own actor',
  from: 'a role change is shown from the audit log',
  to: 'a role change is shown from the audit log',
  role: 'a role change is shown from the audit log',
  self: 'a removal is shown from the audit log',
  email_domain: 'an address domain stays in PostHog',
  email_domains: 'address domains stay in PostHog',
  invitation_id: 'an internal id the timeline does not link',
  via: 'a script grant is shown from the audit log',
  platform_role: 'a staff role is shown from the audit log',
  kind: 'a password link kind is shown from the audit log',
  invitee_user_id: 'another user’s id; the row links its own actor',
  outcome: 'a step-up outcome is shown from the audit log',
  member_count: 'purge statistics stay in PostHog',
  recipient_count: 'reminder statistics stay in PostHog',
  message_ids: 'internal ids the timeline does not link',
  message_id: 'an internal id the timeline does not link',
  tenant_id: 'an invitation email names its tenant; the tenant timeline selects by group',
  range: 'only on timeline_viewed events, which no timeline lists',
  view: 'only on timeline_viewed events, which no timeline lists',
  client_app: 'only on user_flags_evaluated, which no timeline lists',
}

/**
 * An audit row with every metadata key its action's schema declares.
 * @param action - The action.
 * @returns The row; values are placeholders, since the builder only renames keys.
 */
function auditRowFor(action: AuditAction): AuditLog {
  const shape = (AUDIT_ACTIONS[action].metadata as unknown as { shape: Record<string, z.ZodType> })
    .shape
  return {
    id: '0199a1b2-0000-7000-8000-0000000000aa',
    occurredAt: AT,
    actorKind: 'user',
    actorUserId: USER_ID,
    access: 'platform',
    tenantId: TENANT_ID,
    action,
    targetType: AUDIT_ACTIONS[action].target,
    targetId: USER_ID,
    metadata: Object.fromEntries(Object.keys(shape).map((key) => [key, 'value'])),
    requestId: 'req-1',
    ip: '203.0.113.9',
    userAgent: 'Probe/1.0',
  }
}

/**
 * One product event of each type.
 * @returns The events.
 */
function productEvents(): ProductDomainEvent[] {
  return PRODUCT_EVENTS.map((type): ProductDomainEvent => {
    switch (type) {
      case 'user_signed_up':
      case 'user_signed_in': {
        return { type, userId: USER_ID, method: 'google', at: AT }
      }
      case 'onboarding_step_completed': {
        return {
          type,
          tenantId: TENANT_ID,
          userId: USER_ID,
          stepKey: 'configure_settings',
          how: 'auto',
          required: true,
          at: AT,
        }
      }
      default: {
        return { type, userId: USER_ID, at: AT }
      }
    }
  })
}

/**
 * Every property key the builder emits on a listable event: each audit
 * action (and a system one), product event and email event type.
 * @returns The keys.
 */
function emittedKeys(): Set<string> {
  const keys = new Set<string>()
  const add = (properties: Record<string, unknown>): void => {
    for (const key of Object.keys(properties)) keys.add(key)
  }
  for (const action of AUDIT_ACTION_NAMES) {
    const [event] = buildAuditEvents(auditRowFor(action), CONTEXT)
    if (event) add(event.properties)
  }
  const [systemEvent] = buildAuditEvents(
    // eslint-disable-next-line unicorn/no-null -- a system entry has no actor id
    { ...auditRowFor('platform.member.granted'), actorKind: 'system', actorUserId: null },
    CONTEXT
  )
  if (systemEvent) add(systemEvent.properties)
  for (const event of productEvents()) {
    add(
      buildProductEvent(event, CONTEXT, 'member', {
        person: {
          isStaff: false,
          platformRole: null, // eslint-disable-line unicorn/no-null -- the builder's "not staff"
          isEmailVerified: true,
          authProvider: 'google',
          createdAt: AT,
        },
        isViaInvitation: true,
      }).properties
    )
  }
  for (const type of EMAIL_EVENT_TYPES) {
    for (const templateKey of [TENANT_INVITATION_TEMPLATE_KEY, 'email_verification']) {
      add(
        buildEmailEvent(
          {
            type,
            messageId: 'message-1',
            templateKey,
            userId: USER_ID,
            tenantId: TENANT_ID,
            bounceKind: 'hard',
            occurredAt: AT,
          },
          CONTEXT
        ).properties
      )
    }
  }
  return keys
}

describe('TIMELINE_PROP_KEYS', () => {
  const classified = new Set<string>([
    ...TIMELINE_PROP_KEYS,
    ...ROW_FIELD_KEYS,
    ...Object.keys(DELIBERATELY_EXCLUDED),
  ])

  it('classifies every key the builder emits', () => {
    expect([...emittedKeys()].filter((key) => !classified.has(key))).toEqual([])
  })

  it('lists no excluded key that the builder no longer emits', () => {
    const emitted = emittedKeys()
    expect(Object.keys(DELIBERATELY_EXCLUDED).filter((key) => !emitted.has(key))).toEqual([])
  })

  it('never both allowlists and excludes a key', () => {
    const allowed = new Set<string>([...TIMELINE_PROP_KEYS, ...ROW_FIELD_KEYS])
    expect(Object.keys(DELIBERATELY_EXCLUDED).filter((key) => allowed.has(key))).toEqual([])
  })
})

describe('the timeline constants', () => {
  it('maps each range to its hours', () => {
    expect(TIMELINE_RANGE_HOURS).toEqual({ '24h': 24, '7d': 168, '30d': 720, '90d': 2160 })
  })

  it('leaves out both timeline_viewed events, so a page never lists its own audit', () => {
    expect(TIMELINE_EXCLUDED_EVENTS).toContain('user_timeline_viewed')
    expect(TIMELINE_EXCLUDED_EVENTS).toContain('tenant_timeline_viewed')
  })

  it('leaves out exceptions and both errors_viewed events: errors have their own tab', () => {
    expect(TIMELINE_EXCLUDED_EVENTS).toEqual(
      expect.arrayContaining(['$exception', 'user_errors_viewed', 'tenant_errors_viewed'])
    )
  })

  it("leaves out the flag-evaluate audit and PostHog's exposure copy", () => {
    expect(TIMELINE_EXCLUDED_EVENTS).toEqual(
      expect.arrayContaining(['user_flags_evaluated', '$experiment_exposure'])
    )
  })
})
