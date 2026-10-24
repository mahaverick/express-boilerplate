/**
 * @file The analytics event builder, which is pure apart from one warn log:
 * audit action mapping and renames, the event-name collision rule, the
 * common properties, `has_reason`, the tenant group and staff-status rows,
 * product and email events, the one property shape both sources of
 * `onboarding_step_completed` share, snake_case keys, and the PII guard,
 * property-tested over metadata generated from every audit action's own
 * schema.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { z } from 'zod'
import {
  AUDIT_EVENT_RENAMES,
  EMAIL_EVENT_PREFIX,
  PII_PROPERTY_KEYS,
  PRODUCT_EVENTS,
} from '@/constants/analytics.constants'
import {
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  type AuditAccess,
  type AuditAction,
} from '@/constants/audit.constants'
import { BILLING_INTERVALS, STAFF_CANCEL_WHEN } from '@/constants/billing.constants'
import { EMAIL_EVENT_TYPES } from '@/constants/email.constants'
import { MAINTENANCE_MODES } from '@/constants/maintenance-mode.constants'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
import type { WrittenAuditLog } from '@/database/models/audit-log.model'
import {
  auditEventName,
  buildAuditEvents,
  buildEmailEvent,
  buildProductEvent,
  buildTenantGroupIdentify,
  commonProperties,
  scrubPiiProperties,
  toSnakeCaseKeys,
} from '@/services/analytics/analytics-event-builder.service'
import { logger } from '@/services/logger.service'
import type { TenantGroupSnapshot } from '@/types/analytics'
import type {
  BillingDomainEvent,
  BillingEventDetail,
  ProductDomainEvent,
} from '@/types/domain-event'
import { EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'

const OCCURRED_AT = new Date('2026-10-02T09:00:00.000Z')
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000001'
const ACTOR_ID = '0199a1b2-0000-7000-8000-000000000002'
const TARGET_ID = '0199a1b2-0000-7000-8000-000000000003'
const TRACE = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  posthogSessionId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  userId: ACTOR_ID,
}
const PII_NAME = 'Pii Probe'
const PII_EMAIL = 'pii-probe@example.test'
const SNAKE_KEY = /^\$?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const PII_KEYS: ReadonlySet<string> = new Set(PII_PROPERTY_KEYS)

/**
 * Event names both a product (or email) event and a mapped audit action may
 * use. `onboarding_step_completed` is deliberate: a staff completion is
 * audited and forwards from the audit log, every other completion is a
 * product event, and both carry the same properties.
 */
const ALLOWED_EVENT_NAME_OVERLAPS = ['onboarding_step_completed'] as const

/**
 * Text only a banned field (`name`, `reason`, …) is ever given, so finding it
 * in an event can only mean that field leaked.
 */
const BANNED_FIELD_PROBE = 'Banned Field Probe'
/**
 * Text only a `slug` field is given: a tenant slug must never reach an event.
 */
const SLUG_PROBE = 'slug-probe-co'
const NONE = null

/**
 * An inserted audit row, as the repository returns it, for `action` with its
 * already validated `metadata`. `overrides` replaces any other column.
 */
function auditRow(
  action: AuditAction,
  metadata: Record<string, unknown>,
  overrides: Partial<WrittenAuditLog> = {}
): WrittenAuditLog {
  return {
    id: '0199a1b2-0000-7000-8000-0000000000aa',
    occurredAt: OCCURRED_AT,
    actorKind: 'user',
    actorUserId: ACTOR_ID,
    access: 'member',
    tenantId: TENANT_ID,
    action,
    targetType: AUDIT_ACTIONS[action].target,
    targetId: TARGET_ID,
    metadata,
    requestId: 'req-1',
    ip: '203.0.113.9',
    userAgent: 'Probe/1.0',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auditEventName', () => {
  it('maps every audit action to its snake_case event name, applying the renames', () => {
    for (const action of AUDIT_ACTION_NAMES) {
      const renamed = (AUDIT_EVENT_RENAMES as Partial<Record<AuditAction, string>>)[action]
      expect(auditEventName(action)).toBe(renamed ?? action.replaceAll('.', '_'))
      expect(auditEventName(action)).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
    }
    expect(auditEventName('invitation.created')).toBe('invitation_created')
    expect(auditEventName('user.signed_out')).toBe('user_sessions_revoked')
  })

  it('gives every audit action its own event name', () => {
    const names = AUDIT_ACTION_NAMES.map((action) => auditEventName(action))
    expect(new Set(names).size).toBe(names.length)
  })

  it('renames only actions that exist', () => {
    for (const action of Object.keys(AUDIT_EVENT_RENAMES)) {
      expect(AUDIT_ACTION_NAMES).toContain(action)
    }
  })
})

describe('event-name collision rule', () => {
  it('lets a product or email event share a name with an audit event only where allowed', () => {
    const auditNames = new Set(AUDIT_ACTION_NAMES.map((action) => auditEventName(action)))
    const otherNames = [
      ...PRODUCT_EVENTS,
      ...EMAIL_EVENT_TYPES.map((type) => `${EMAIL_EVENT_PREFIX}${type}`),
    ]

    const overlaps = otherNames
      .filter((name) => auditNames.has(name))
      .toSorted((left, right) => left.localeCompare(right))

    expect(overlaps).toEqual(
      [...ALLOWED_EVENT_NAME_OVERLAPS].toSorted((left, right) => left.localeCompare(right))
    )
  })

  it('includes the email event names in the check', () => {
    expect(EMAIL_EVENT_TYPES.map((type) => `${EMAIL_EVENT_PREFIX}${type}`)).toContain(
      'email_delivered'
    )
  })
})

describe('buildAuditEvents', () => {
  it('builds one event with the target, the metadata in snake_case and every common property', () => {
    const rows = buildAuditEvents(
      auditRow('member.role_changed', { userId: TARGET_ID, from: 'viewer', to: 'admin' }),
      TRACE
    )

    expect(rows).toEqual([
      {
        event: 'member_role_changed',
        distinctId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
        properties: {
          target_type: 'membership',
          target_id: TARGET_ID,
          user_id: TARGET_ID,
          from: 'viewer',
          to: 'admin',
          source: 'audit',
          access: 'member',
          app: 'api',
          $groups: { tenant: TENANT_ID },
          trace_id: TRACE.traceId,
          span_id: TRACE.spanId,
          $session_id: TRACE.posthogSessionId,
        },
      },
    ])
  })

  it('omits the trace and session properties when the context has none', () => {
    const [row] = buildAuditEvents(auditRow('tenant.updated', { changed: ['name'] }), {})
    expect(row?.properties).not.toHaveProperty('trace_id')
    expect(row?.properties).not.toHaveProperty('span_id')
    expect(row?.properties).not.toHaveProperty('$session_id')
  })

  it('sends a system actor as the system distinct id with no person profile', () => {
    const [row] = buildAuditEvents(
      auditRow(
        'platform.member.granted',
        { userId: TARGET_ID, role: 'owner', via: 'script' },
        { actorKind: 'system', actorUserId: NONE, access: 'system' }
      ),
      {}
    )
    expect(row).toMatchObject({
      distinctId: 'system',
      properties: { access: 'system', $process_person_profile: false },
    })
  })

  it('keeps a person profile for a user actor', () => {
    const [row] = buildAuditEvents(auditRow('tenant.updated', { changed: ['name'] }), {})
    expect(row?.properties).not.toHaveProperty('$process_person_profile')
  })

  it('carries platform access through for a staff action', () => {
    const [row] = buildAuditEvents(
      auditRow('tenant.suspended', { reason: 'Unpaid invoices' }, { access: 'platform' }),
      {}
    )
    expect(row?.properties).toMatchObject({ access: 'platform' })
  })

  it('turns a staff reason into has_reason, never the text', () => {
    const [row] = buildAuditEvents(
      auditRow('user.deactivated', { reason: `Asked by ${PII_EMAIL}` }),
      {}
    )
    expect(row?.properties).toMatchObject({ has_reason: true })
    expect(row?.properties).not.toHaveProperty('reason')
    expect(JSON.stringify(row)).not.toContain(PII_EMAIL)
  })

  it('reports has_reason false for a nullable reason that is null', () => {
    const [row] = buildAuditEvents(
      auditRow('tenant.owner_invited', {
        emailDomain: 'example.test',
        inviteeUserId: NONE,
        reason: NONE,
      }),
      {}
    )
    expect(row?.properties).toMatchObject({
      has_reason: false,
      email_domain: 'example.test',
      invitee_user_id: NONE,
    })
  })

  it('adds no has_reason to an action without a reason', () => {
    const [row] = buildAuditEvents(auditRow('tenant.updated', { changed: ['name'] }), {})
    expect(row?.properties).not.toHaveProperty('has_reason')
  })

  it("keeps a tenant's name off the event and off its group marker", () => {
    const rows = buildAuditEvents(
      auditRow('tenant.created', { name: PII_NAME, slug: 'probe-co' }),
      TRACE,
      {
        tenant: {
          id: TENANT_ID,
          name: PII_NAME,
          status: 'active',
          createdAt: OCCURRED_AT,
          isPlatform: false,
        },
      }
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]?.properties).not.toHaveProperty('slug')
    expect(JSON.stringify(rows[0])).not.toContain('probe-co')
    expect(JSON.stringify(rows[0])).not.toContain(PII_NAME)
    // A marker: the drainer adds `$group_set` from the tenant row when it sends it.
    expect(rows[1]).toEqual({
      event: '$groupidentify',
      distinctId: `$tenant_${TENANT_ID}`,
      occurredAt: OCCURRED_AT,
      properties: {
        source: 'audit',
        trace_id: TRACE.traceId,
        $group_type: 'tenant',
        $group_key: TENANT_ID,
      },
    })
    expect(JSON.stringify(rows[1])).not.toContain(PII_NAME)
  })

  it("adds a $set row for the affected user's staff status, not the actor's", () => {
    const rows = buildAuditEvents(
      auditRow('member.removed', { userId: TARGET_ID, role: 'admin', self: false }),
      {},
      { staffStatus: { userId: TARGET_ID, platformRole: NONE } }
    )

    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({
      event: '$set',
      distinctId: TARGET_ID,
      occurredAt: OCCURRED_AT,
      properties: {
        source: 'audit',
        access: 'member',
        app: 'api',
        $set: { is_staff: false, platform_role: NONE },
      },
    })
    expect(rows[0]?.distinctId).toBe(ACTOR_ID)
  })

  it('marks a user staff in the $set row while they hold a platform role', () => {
    const rows = buildAuditEvents(
      auditRow('platform.member.granted', { userId: TARGET_ID, role: 'viewer', via: 'script' }),
      {},
      { staffStatus: { userId: TARGET_ID, platformRole: 'viewer' } }
    )
    expect(rows[1]?.properties).toMatchObject({ $set: { is_staff: true, platform_role: 'viewer' } })
  })

  it('gives a staff onboarding completion the manual how and the step registry required flag', () => {
    const [required] = buildAuditEvents(
      auditRow(
        'onboarding.step_completed',
        { reason: 'Done on a call', stepKey: 'configure_settings' },
        { access: 'platform' }
      ),
      {}
    )
    const [optional] = buildAuditEvents(
      auditRow('onboarding.step_completed', { reason: 'Done', stepKey: 'teammate_joined' }),
      {}
    )
    const [removed] = buildAuditEvents(
      auditRow('onboarding.step_completed', { reason: 'Done', stepKey: 'retired_step' }),
      {}
    )

    expect(required).toMatchObject({
      event: 'onboarding_step_completed',
      properties: {
        step_key: 'configure_settings',
        how: 'manual',
        required: true,
        has_reason: true,
      },
    })
    expect(optional?.properties).toMatchObject({ required: false })
    expect(removed?.properties).toMatchObject({ required: false })
  })
})

describe('session attribution', () => {
  const session = { posthogSessionId: TRACE.posthogSessionId }

  it('adds $session_id to the actor own audit event', () => {
    const [row] = buildAuditEvents(auditRow('tenant.updated', { changed: ['name'] }), {
      ...session,
      userId: ACTOR_ID,
    })
    expect(row?.properties).toMatchObject({ $session_id: TRACE.posthogSessionId })
  })

  it('omits $session_id from a staff $set for another user', () => {
    const rows = buildAuditEvents(
      auditRow('member.removed', { userId: TARGET_ID, role: 'admin', self: false }),
      { ...session, userId: ACTOR_ID },
      { staffStatus: { userId: TARGET_ID, platformRole: NONE } }
    )
    expect(rows[0]?.properties).toHaveProperty('$session_id')
    expect(rows[1]?.event).toBe('$set')
    expect(rows[1]?.properties).not.toHaveProperty('$session_id')
  })

  it('adds $session_id to a staff $set for the actor', () => {
    const rows = buildAuditEvents(
      auditRow('invitation.accepted', { role: 'viewer' }),
      { ...session, userId: ACTOR_ID },
      { staffStatus: { userId: ACTOR_ID, platformRole: 'viewer' } }
    )
    expect(rows[1]?.event).toBe('$set')
    expect(rows[1]?.properties).toHaveProperty('$session_id', TRACE.posthogSessionId)
  })

  it('never adds $session_id to a $groupidentify, and sends no person-profile flag', () => {
    const row = buildTenantGroupIdentify(
      { id: TENANT_ID },
      { ...session, userId: ACTOR_ID },
      'audit',
      OCCURRED_AT
    )
    expect(row.properties).not.toHaveProperty('$session_id')
    expect(row.properties).not.toHaveProperty('$process_person_profile')
  })

  it('omits $session_id from a system row inside a user request', () => {
    const [row] = buildAuditEvents(
      auditRow(
        'platform.member.granted',
        { userId: TARGET_ID, role: 'viewer', via: 'script' },
        { actorKind: 'system', actorUserId: NONE, access: 'system' }
      ),
      { ...session, userId: ACTOR_ID }
    )
    expect(row?.distinctId).toBe('system')
    expect(row?.properties).not.toHaveProperty('$session_id')
  })

  it('omits $session_id from an event whose distinct id is not the request user', () => {
    const properties = commonProperties({
      source: 'product',
      access: 'member',
      distinctId: TARGET_ID,
      context: { ...session, userId: ACTOR_ID },
    })
    expect(properties).not.toHaveProperty('$session_id')
  })

  it('omits $session_id from an unauthenticated event that is not a sign-in', () => {
    const row = buildProductEvent(
      { type: 'email_verified', userId: TARGET_ID, at: OCCURRED_AT },
      session
    )
    expect(row.properties).not.toHaveProperty('$session_id')
  })

  it.each(['user_signed_in', 'user_signed_up'] as const)(
    'adds $session_id to %s when the request has no authenticated user',
    (type) => {
      const row = buildProductEvent(
        { type, userId: TARGET_ID, method: 'link', at: OCCURRED_AT },
        session
      )
      expect(row.properties).toHaveProperty('$session_id', TRACE.posthogSessionId)
    }
  )

  it('adds $session_id to the user’s own user_signed_out when no user is authenticated', () => {
    const row = buildProductEvent(
      { type: 'user_signed_out', userId: TARGET_ID, at: OCCURRED_AT },
      session
    )
    expect(row.properties).toHaveProperty('$session_id', TRACE.posthogSessionId)
  })

  it('omits $session_id from a user_signed_out sent while another user is authenticated', () => {
    const row = buildProductEvent(
      { type: 'user_signed_out', userId: TARGET_ID, at: OCCURRED_AT },
      { ...session, userId: ACTOR_ID }
    )
    expect(row.properties).not.toHaveProperty('$session_id')
  })

  it('omits $session_id from a sign-in made while another user is authenticated', () => {
    const row = buildProductEvent(
      { type: 'user_signed_in', userId: TARGET_ID, method: 'link', at: OCCURRED_AT },
      { ...session, userId: ACTOR_ID }
    )
    expect(row.properties).not.toHaveProperty('$session_id')
  })
})

describe('buildTenantGroupIdentify', () => {
  it('builds a marker with only the group, its source and no trace, for a caller with no audit row', () => {
    // A full snapshot, as the backfill passes: nothing but its id may be stored.
    const tenant: TenantGroupSnapshot = {
      id: TENANT_ID,
      name: 'Acme',
      status: 'suspended',
      createdAt: OCCURRED_AT,
      isPlatform: false,
    }
    const row = buildTenantGroupIdentify(tenant, {}, 'backfill', OCCURRED_AT)
    expect(row).toEqual({
      event: '$groupidentify',
      distinctId: `$tenant_${TENANT_ID}`,
      occurredAt: OCCURRED_AT,
      properties: { source: 'backfill', $group_type: 'tenant', $group_key: TENANT_ID },
    })
    expect(JSON.stringify(row)).not.toContain('Acme')
  })

  it('carries the trace id but no span, session, access or app', () => {
    const row = buildTenantGroupIdentify({ id: TENANT_ID }, TRACE, 'audit', OCCURRED_AT)
    expect(
      Object.keys(row.properties).toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['$group_key', '$group_type', 'source', 'trace_id'])
    expect(row.properties.trace_id).toBe(TRACE.traceId)
  })
})

describe('toSnakeCaseKeys', () => {
  it('converts every camelCase key and leaves values alone', () => {
    expect(
      toSnakeCaseKeys({ stepKey: 'a', userId: 'b', emailDomains: ['x.test'], self: true })
    ).toEqual({ step_key: 'a', user_id: 'b', email_domains: ['x.test'], self: true })
  })
})

describe('scrubPiiProperties', () => {
  it('drops every banned key, whatever its value', () => {
    const banned = Object.fromEntries(PII_PROPERTY_KEYS.map((key) => [key, 'x']))
    const result = scrubPiiProperties({ ...banned, step_key: 'kept' })
    expect(result.properties).toEqual({ step_key: 'kept' })
    expect(result.droppedKeys.toSorted((left, right) => left.localeCompare(right))).toEqual(
      [...PII_PROPERTY_KEYS].toSorted((left, right) => left.localeCompare(right))
    )
  })

  it('drops an address-shaped value, alone or inside an array, under any key', () => {
    const result = scrubPiiProperties({
      slug: PII_EMAIL,
      list: ['ok', PII_EMAIL],
      domain: 'example.test',
      handle: '@probe',
      count: 3,
    })
    expect(result.properties).toEqual({ domain: 'example.test', handle: '@probe', count: 3 })
    expect(result.droppedKeys).toEqual(['slug', 'list'])
  })

  it('does not look inside nested objects such as $set or $group_set', () => {
    const result = scrubPiiProperties({ $group_set: { name: PII_NAME } })
    expect(result.properties).toEqual({ $group_set: { name: PII_NAME } })
  })

  it('logs the dropped keys of a built event at warn, never their values', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    buildAuditEvents(auditRow('user.created', { emailDomain: PII_EMAIL }), {})

    expect(warn).toHaveBeenCalledWith('Analytics properties dropped by the PII guard', {
      event: 'user_created',
      droppedKeys: ['email_domain'],
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PII_EMAIL)
  })
})

/**
 * A seeded pseudo-random generator (mulberry32), so a failing case
 * reproduces on every run. Each call of the returned function yields a number
 * in [0, 1).
 */
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = Math.trunc(state + 0x6d_2b_79_f5)
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * A seed derived from an action's name, so each action draws the same
 * samples whether or not the others run. The seed is an unsigned 32-bit
 * FNV-1a hash of the name.
 */
function seedOf(action: string): number {
  let hash = 2_166_136_261
  for (const char of action) hash = Math.imul(hash ^ char.codePointAt(0)!, 16_777_619)
  return hash >>> 0
}

/**
 * Candidate values for a metadata field, the PII probes first. Each field
 * keeps only the candidates its own schema accepts.
 */
const CANDIDATES: readonly unknown[] = [
  PII_EMAIL,
  PII_NAME,
  `${PII_NAME} <${PII_EMAIL}>`,
  [PII_EMAIL],
  'example.test',
  ['example.test', 'mail.example.test'],
  'probe-co',
  TARGET_ID,
  [TARGET_ID],
  ['name', 'settingsJson'],
  [],
  'configure_settings',
  'script',
  'setup',
  'reset',
  'link',
  'google',
  ...MEMBERSHIP_ROLES,
  ...MAINTENANCE_MODES,
  ...EMAIL_TEMPLATE_KEYS,
  ...BILLING_INTERVALS,
  ...STAFF_CANCEL_WHEN,
  '2026-11-02T10:00:00.000Z',
  'react',
  'apex',
  true,
  false,
  0,
  7,
  NONE,
]

/**
 * Candidate values for a banned field: the probe text only it carries, the
 * address probe, and null for a nullable one.
 */
const BANNED_FIELD_CANDIDATES: readonly unknown[] = [
  BANNED_FIELD_PROBE,
  PII_EMAIL,
  `${BANNED_FIELD_PROBE} <${PII_EMAIL}>`,
  NONE,
]

/**
 * The candidates for one metadata field: a slug and a banned field each get
 * probe text of their own.
 */
function candidatesFor(key: string): readonly unknown[] {
  if (key === 'slug') return [SLUG_PROBE]
  return PII_KEYS.has(key) ? BANNED_FIELD_CANDIDATES : CANDIDATES
}

/**
 * Up to `count` metadata objects that `schema` accepts, each field drawn
 * from the candidates its own schema accepts (a banned field from its own
 * candidates). `schema` is an audit action's strict metadata schema, and
 * `random` is the seeded generator that makes the draw repeatable.
 */
function sampleMetadata(
  schema: z.ZodType,
  random: () => number,
  count: number
): Record<string, unknown>[] {
  const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape
  const options = Object.entries(shape).map(
    ([key, field]) =>
      [key, candidatesFor(key).filter((candidate) => field.safeParse(candidate).success)] as const
  )
  const samples: Record<string, unknown>[] = []
  for (let index = 0; index < count; index += 1) {
    const sample = Object.fromEntries(
      options.map(([key, values]) => [key, values[Math.floor(random() * values.length)]])
    )
    if (schema.safeParse(sample).success) samples.push(sample)
  }
  return samples
}

describe('the PII guard over every audit action', () => {
  const accesses: AuditAccess[] = ['member', 'platform', 'system']

  it.each(AUDIT_ACTION_NAMES)('%s: no banned key, no address, snake_case keys only', (action) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const random = seededRandom(seedOf(action))
    const samples = sampleMetadata(AUDIT_ACTIONS[action].metadata, random, 50)

    // A schema the generator cannot satisfy would otherwise pass by testing nothing.
    expect(samples.length).toBeGreaterThan(0)
    for (const [index, metadata] of samples.entries()) {
      const rows = buildAuditEvents(
        auditRow(action, metadata, { access: accesses[index % accesses.length] ?? 'member' }),
        TRACE
      )
      const [event] = rows
      if (!event) throw new Error('no event row')
      const keys = Object.keys(event.properties)
      for (const key of keys) expect(key).toMatch(SNAKE_KEY)
      for (const key of PII_PROPERTY_KEYS) expect(keys).not.toContain(key)
      const sent = JSON.stringify(event)
      expect(sent).not.toContain(PII_EMAIL)
      expect(sent).not.toContain(BANNED_FIELD_PROBE)
      expect(sent).not.toContain(SLUG_PROBE)
      expect(event.properties).toMatchObject({ source: 'audit', app: 'api' })
      if (Object.hasOwn(metadata, 'reason')) {
        expect(typeof event.properties.has_reason).toBe('boolean')
      }
    }
  })
})

describe('buildProductEvent', () => {
  const person = {
    isStaff: true,
    platformRole: 'viewer' as const,
    isEmailVerified: true,
    authProvider: 'google' as const,
    createdAt: OCCURRED_AT,
  }

  it("gives a sign-up its method, invitation flag and the user's server-owned person properties", () => {
    const row = buildProductEvent(
      { type: 'user_signed_up', userId: ACTOR_ID, method: 'google', at: OCCURRED_AT },
      TRACE,
      'member',
      { person, isViaInvitation: true }
    )

    expect(row).toEqual({
      event: 'user_signed_up',
      distinctId: ACTOR_ID,
      occurredAt: OCCURRED_AT,
      properties: {
        method: 'google',
        via_invitation: true,
        $set: {
          is_staff: true,
          platform_role: 'viewer',
          email_verified: true,
          auth_provider: 'google',
        },
        $set_once: { created_at: OCCURRED_AT.toISOString() },
        source: 'product',
        access: 'member',
        app: 'api',
        trace_id: TRACE.traceId,
        span_id: TRACE.spanId,
        $session_id: TRACE.posthogSessionId,
      },
    })
  })

  it('defaults via_invitation to false and leaves person properties off when none were read', () => {
    const row = buildProductEvent(
      { type: 'user_signed_up', userId: ACTOR_ID, method: 'link', at: OCCURRED_AT },
      {}
    )
    expect(row.properties).toMatchObject({ method: 'link', via_invitation: false })
    expect(row.properties).not.toHaveProperty('$set')
    expect(row.properties).not.toHaveProperty('$set_once')
  })

  it('gives a sign-in its method and person properties, but no invitation flag', () => {
    const row = buildProductEvent(
      { type: 'user_signed_in', userId: ACTOR_ID, method: 'link', at: OCCURRED_AT },
      {},
      'member',
      { person: { ...person, authProvider: 'link' } }
    )
    expect(row.properties).toMatchObject({
      method: 'link',
      $set: { auth_provider: 'link' },
    })
    expect(row.properties).not.toHaveProperty('via_invitation')
  })

  it.each(['user_signed_out', 'other_sessions_revoked', 'email_verified'] as const)(
    'sends %s as the user with only the common properties and no group',
    (type) => {
      const row = buildProductEvent({ type, userId: ACTOR_ID, at: OCCURRED_AT }, {})
      expect(row).toEqual({
        event: type,
        distinctId: ACTOR_ID,
        occurredAt: OCCURRED_AT,
        properties: { source: 'product', access: 'member', app: 'api' },
      })
    }
  )

  it('never sets person properties on an event other than a sign-up or sign-in', () => {
    const row = buildProductEvent(
      { type: 'other_sessions_revoked', userId: ACTOR_ID, at: OCCURRED_AT },
      {},
      'member',
      { person }
    )
    expect(row.properties).not.toHaveProperty('$set')
  })

  it('sends an onboarding completion in its tenant group as the member who completed it', () => {
    const row = buildProductEvent(
      {
        type: 'onboarding_step_completed',
        tenantId: TENANT_ID,
        userId: ACTOR_ID,
        stepKey: 'configure_settings',
        how: 'auto',
        required: true,
        at: OCCURRED_AT,
      },
      {}
    )
    expect(row).toEqual({
      event: 'onboarding_step_completed',
      distinctId: ACTOR_ID,
      occurredAt: OCCURRED_AT,
      properties: {
        step_key: 'configure_settings',
        how: 'auto',
        required: true,
        source: 'product',
        access: 'member',
        app: 'api',
        $groups: { tenant: TENANT_ID },
      },
    })
  })

  it('sends a reconciled completion, which has no user, as a system event', () => {
    const row = buildProductEvent(
      {
        type: 'onboarding_step_completed',
        tenantId: TENANT_ID,
        userId: NONE,
        stepKey: 'invite_teammate',
        how: 'auto',
        required: true,
        at: OCCURRED_AT,
      },
      {}
    )
    expect(row).toMatchObject({
      distinctId: 'system',
      properties: { access: 'system', $process_person_profile: false },
    })
  })

  it('gives every product event snake_case keys only', () => {
    const events: ProductDomainEvent[] = [
      { type: 'user_signed_up', userId: ACTOR_ID, method: 'link', at: OCCURRED_AT },
      { type: 'user_signed_in', userId: ACTOR_ID, method: 'google', at: OCCURRED_AT },
      { type: 'user_signed_out', userId: ACTOR_ID, at: OCCURRED_AT },
      { type: 'other_sessions_revoked', userId: ACTOR_ID, at: OCCURRED_AT },
      { type: 'email_verified', userId: ACTOR_ID, at: OCCURRED_AT },
      {
        type: 'onboarding_step_completed',
        tenantId: TENANT_ID,
        userId: ACTOR_ID,
        stepKey: 'read_getting_started',
        how: 'manual',
        required: false,
        at: OCCURRED_AT,
      },
      ...BILLING_DETAILS.map((detail) => billingEvent(detail)),
    ]
    expect(
      events.map((event) => event.type).toSorted((left, right) => left.localeCompare(right))
    ).toEqual([...PRODUCT_EVENTS].toSorted((left, right) => left.localeCompare(right)))
    for (const event of events) {
      const row = buildProductEvent(event, TRACE, 'member', { person, isViaInvitation: false })
      for (const key of Object.keys(row.properties)) expect(key).toMatch(SNAKE_KEY)
    }
  })
})

/**
 * One of each billing event's own fields, every field set.
 */
const BILLING_DETAILS: readonly BillingEventDetail[] = [
  { type: 'trial_started' },
  { type: 'trial_reminder_sent', daysLeft: 3 },
  { type: 'trial_extended', days: 7 },
  { type: 'trial_ended' },
  { type: 'plan_limit_approaching', key: 'members', used: 8, limit: 10 },
  { type: 'plan_limit_reached', key: 'members', usage: { used: 3, limit: 3 } },
  { type: 'plan_feature_blocked', key: 'advanced_example' },
  { type: 'upgrade_requested', key: 'members', surface: 'invite_dialog' },
  { type: 'upgrade_request_fulfilled' },
  {
    type: 'checkout_started',
    interval: 'month',
    amountMinor: 99_900,
    currency: 'INR',
    duringTrial: true,
  },
  { type: 'checkout_confirmed' },
  { type: 'subscription_activated', interval: 'year' },
  { type: 'subscription_renewed' },
  { type: 'payment_failed', failureCode: 'halted' },
  { type: 'subscription_recovered' },
  { type: 'subscription_halted' },
  { type: 'subscription_cancel_scheduled', by: 'customer_bank' },
  { type: 'subscription_interval_change_scheduled' },
  { type: 'downgraded_to_free', downgradeCause: 'payment_failed' },
  { type: 'payer_left' },
  { type: 'duplicate_subscription_refunded' },
  { type: 'billing_reconciled', field: 'state' },
  { type: 'dispute_opened' },
]

/**
 * A billing event attributed to the actor, on Paid and active, unless `base` says otherwise.
 * @param detail - The event's type and own fields.
 * @param base - Fields of the base to replace.
 * @returns The event.
 */
function billingEvent(
  detail: BillingEventDetail,
  base: Partial<Omit<BillingDomainEvent, 'type'>> = {}
): BillingDomainEvent {
  return {
    tenantId: TENANT_ID,
    userId: NONE,
    attributedUserId: ACTOR_ID,
    plan: 'paid',
    billingState: 'active',
    at: OCCURRED_AT,
    ...base,
    ...detail,
  }
}

describe('buildProductEvent for a billing event', () => {
  it('sends a provider-driven change as the attributed person, in the tenant group, as a system action', () => {
    const row = buildProductEvent(
      billingEvent({ type: 'subscription_activated', interval: 'month' }),
      TRACE
    )

    expect(row).toEqual({
      event: 'subscription_activated',
      distinctId: ACTOR_ID,
      occurredAt: OCCURRED_AT,
      properties: {
        interval: 'month',
        plan: 'paid',
        billing_state: 'active',
        source: 'product',
        access: 'system',
        app: 'api',
        $groups: { tenant: TENANT_ID },
        trace_id: TRACE.traceId,
        span_id: TRACE.spanId,
        $session_id: TRACE.posthogSessionId,
      },
    })
  })

  it('sends a member action as that member with their access, ahead of any attributed person', () => {
    const row = buildProductEvent(
      billingEvent(
        { type: 'plan_feature_blocked', key: 'advanced_example' },
        { userId: TARGET_ID, plan: 'free', billingState: 'free' }
      ),
      {},
      'member'
    )

    expect(row.distinctId).toBe(TARGET_ID)
    expect(row.properties).toMatchObject({
      key: 'advanced_example',
      plan: 'free',
      billing_state: 'free',
      access: 'member',
      $groups: { tenant: TENANT_ID },
    })
  })

  it('sends a change with no known person as the system distinct id with no person profile', () => {
    const row = buildProductEvent(
      billingEvent({ type: 'trial_ended' }, { attributedUserId: NONE, plan: 'free' }),
      {}
    )

    expect(row).toMatchObject({
      distinctId: 'system',
      properties: {
        access: 'system',
        $process_person_profile: false,
        $groups: { tenant: TENANT_ID },
      },
    })
  })

  it('names the cause and the failure in their own keys, never reason', () => {
    const downgrade = buildProductEvent(
      billingEvent({ type: 'downgraded_to_free', downgradeCause: 'trial_ended' }),
      {}
    )
    const failure = buildProductEvent(
      billingEvent({ type: 'payment_failed', failureCode: 'paused' }),
      {}
    )

    expect(downgrade.properties).toMatchObject({ downgrade_cause: 'trial_ended' })
    expect(failure.properties).toMatchObject({ failure_code: 'paused' })
    expect(downgrade.properties).not.toHaveProperty('reason')
    expect(failure.properties).not.toHaveProperty('reason')
  })

  it.each(BILLING_DETAILS.map((detail) => [detail.type, detail] as const))(
    'gives %s plan, billing_state and the tenant group, and no PII key',
    (_type, detail) => {
      const row = buildProductEvent(billingEvent(detail, { billingState: 'past_due' }), TRACE)

      expect(row.properties).toMatchObject({
        plan: 'paid',
        billing_state: 'past_due',
        $groups: { tenant: TENANT_ID },
      })
      for (const key of Object.keys(row.properties)) {
        expect(PII_KEYS.has(key)).toBe(false)
        expect(key).toMatch(SNAKE_KEY)
      }
    }
  )

  it('gives the checkout properties in snake_case', () => {
    const row = buildProductEvent(
      billingEvent({
        type: 'checkout_started',
        interval: 'year',
        amountMinor: 999_000,
        currency: 'INR',
        duringTrial: false,
      }),
      {}
    )

    expect(row.properties).toMatchObject({
      interval: 'year',
      amount_minor: 999_000,
      currency: 'INR',
      during_trial: false,
    })
  })

  it('derives a stable UUID row id from the dedupe key, and none without one', () => {
    const first = buildProductEvent(billingEvent({ type: 'trial_ended' }, { dedupeKey: 'k-1' }), {})
    const again = buildProductEvent(billingEvent({ type: 'trial_ended' }, { dedupeKey: 'k-1' }), {})
    const other = buildProductEvent(billingEvent({ type: 'trial_ended' }, { dedupeKey: 'k-2' }), {})
    const keyless = buildProductEvent(billingEvent({ type: 'trial_ended' }), {})

    expect(first.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(again.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect(keyless).not.toHaveProperty('id')
  })
})

describe('onboarding_step_completed from both sources', () => {
  it('shares one snake_case property shape: step_key, how, required', () => {
    const common = new Set(
      Object.keys(
        commonProperties({
          source: 'audit',
          access: 'platform',
          distinctId: ACTOR_ID,
          tenantId: TENANT_ID,
          context: TRACE,
        })
      )
    )
    const [audited] = buildAuditEvents(
      auditRow(
        'onboarding.step_completed',
        { reason: 'Done on a call', stepKey: 'invite_teammate' },
        { access: 'platform' }
      ),
      TRACE
    )
    const product = buildProductEvent(
      {
        type: 'onboarding_step_completed',
        tenantId: TENANT_ID,
        userId: ACTOR_ID,
        stepKey: 'invite_teammate',
        how: 'manual',
        required: true,
        at: OCCURRED_AT,
      },
      TRACE
    )
    /**
     * The sorted property keys that are neither common to every event nor in
     * `extra`, which is what the event adds of its own.
     */
    const own = (properties: Record<string, unknown>, extra: string[]): string[] =>
      Object.keys(properties)
        .filter((key) => !common.has(key) && !extra.includes(key))
        .toSorted((left, right) => left.localeCompare(right))

    expect(audited?.event).toBe(product.event)
    expect(own(audited?.properties ?? {}, ['target_type', 'target_id', 'has_reason'])).toEqual([
      'how',
      'required',
      'step_key',
    ])
    expect(own(product.properties, [])).toEqual(['how', 'required', 'step_key'])
    expect(audited?.properties).toMatchObject({
      step_key: 'invite_teammate',
      how: 'manual',
      required: true,
    })
  })
})

describe('buildEmailEvent', () => {
  it("sends a stored event as the message's user, in its tenant, with no recipient or detail", () => {
    const row = buildEmailEvent(
      {
        type: 'bounced',
        messageId: TARGET_ID,
        templateKey: 'onboarding_reminder',
        userId: ACTOR_ID,
        tenantId: TENANT_ID,
        bounceKind: 'hard',
        occurredAt: OCCURRED_AT,
      },
      { traceId: TRACE.traceId, spanId: TRACE.spanId }
    )
    expect(row).toEqual({
      event: 'email_bounced',
      distinctId: ACTOR_ID,
      occurredAt: OCCURRED_AT,
      properties: {
        template_key: 'onboarding_reminder',
        message_id: TARGET_ID,
        bounce_kind: 'hard',
        source: 'email',
        access: 'system',
        app: 'api',
        $groups: { tenant: TENANT_ID },
        trace_id: TRACE.traceId,
        span_id: TRACE.spanId,
      },
    })
  })

  it('sends an invitation email event with tenant_id as a plain property and no group', () => {
    const row = buildEmailEvent(
      {
        type: 'delivered',
        messageId: TARGET_ID,
        templateKey: 'tenant_invitation',
        userId: ACTOR_ID,
        tenantId: TENANT_ID,
        bounceKind: NONE,
        occurredAt: OCCURRED_AT,
      },
      {}
    )
    expect(row.properties).toMatchObject({
      template_key: 'tenant_invitation',
      tenant_id: TENANT_ID,
    })
    expect(row.properties).not.toHaveProperty('$groups')
  })

  it('sends an invitation email event with no tenant without a tenant_id', () => {
    const row = buildEmailEvent(
      {
        type: 'delivered',
        messageId: TARGET_ID,
        templateKey: 'tenant_invitation',
        userId: ACTOR_ID,
        tenantId: NONE,
        bounceKind: NONE,
        occurredAt: OCCURRED_AT,
      },
      {}
    )
    expect(row.properties).not.toHaveProperty('tenant_id')
    expect(row.properties).not.toHaveProperty('$groups')
  })

  it('sends a message with no user as a system event without a group or bounce kind', () => {
    const row = buildEmailEvent(
      {
        type: 'delivered',
        messageId: TARGET_ID,
        templateKey: 'registration_attempt',
        userId: NONE,
        tenantId: NONE,
        bounceKind: NONE,
        occurredAt: OCCURRED_AT,
      },
      {}
    )
    expect(row).toEqual({
      event: 'email_delivered',
      distinctId: 'system',
      occurredAt: OCCURRED_AT,
      properties: {
        template_key: 'registration_attempt',
        message_id: TARGET_ID,
        source: 'email',
        access: 'system',
        app: 'api',
        $process_person_profile: false,
      },
    })
  })

  it.each(EMAIL_EVENT_TYPES)('names a %s event email_<type>', (type) => {
    const row = buildEmailEvent(
      {
        type,
        messageId: TARGET_ID,
        templateKey: 'email_verification',
        userId: NONE,
        tenantId: NONE,
        bounceKind: NONE,
        occurredAt: OCCURRED_AT,
      },
      {}
    )
    expect(row.event).toBe(`${EMAIL_EVENT_PREFIX}${type}`)
  })
})
