/**
 * @file The analytics event builder, which is pure apart from one warn log:
 * audit action mapping and renames, the event-name collision rule, the
 * common properties, `has_reason`, the tenant group and staff-status rows,
 * snake_case keys, and the PII guard, property-tested over metadata
 * generated from every audit action's own schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  ALLOWED_EVENT_NAME_OVERLAPS,
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
import { EMAIL_EVENT_TYPES } from '@/constants/email.constants'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
import type { AuditLog } from '@/database/models/audit-log.model'
import {
  auditEventName,
  buildAuditEvents,
  buildTenantGroupIdentify,
  scrubPiiProperties,
  toSnakeCaseKeys,
} from '@/services/analytics/analytics-event-builder.service'
import { logger } from '@/services/logger.service'
import { EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'

const OCCURRED_AT = new Date('2026-10-02T09:00:00.000Z')
const TENANT_ID = '0199a1b2-0000-7000-8000-000000000001'
const ACTOR_ID = '0199a1b2-0000-7000-8000-000000000002'
const TARGET_ID = '0199a1b2-0000-7000-8000-000000000003'
const TRACE = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  posthogSessionId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
}
const PII_NAME = 'Pii Probe'
const PII_EMAIL = 'pii-probe@example.test'
const SNAKE_KEY = /^\$?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const PII_KEYS: ReadonlySet<string> = new Set(PII_PROPERTY_KEYS)
/**
 * Text only a banned field (`name`, `reason`, …) is ever given, so finding it
 * in an event can only mean that field leaked.
 */
const BANNED_FIELD_PROBE = 'Banned Field Probe'
/**
 * Text only a `slug` field is given: a tenant slug must never reach an event.
 */
const SLUG_PROBE = 'slug-probe-co'
// eslint-disable-next-line unicorn/no-null -- audit_logs columns are nullable, and the row type says so
const NONE = null

/**
 * An inserted audit row, as the repository returns it.
 * @param action - The action.
 * @param metadata - Its validated metadata.
 * @param overrides - Other columns to set.
 * @returns The row.
 */
function auditRow(
  action: AuditAction,
  metadata: Record<string, unknown>,
  overrides: Partial<AuditLog> = {}
): AuditLog {
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

  it("keeps a tenant's name off the event and puts it on the group identify row", () => {
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
    expect(rows[1]).toEqual({
      event: '$groupidentify',
      distinctId: `$tenant_${TENANT_ID}`,
      occurredAt: OCCURRED_AT,
      properties: {
        source: 'audit',
        access: 'member',
        app: 'api',
        trace_id: TRACE.traceId,
        span_id: TRACE.spanId,
        $session_id: TRACE.posthogSessionId,
        $process_person_profile: false,
        $group_type: 'tenant',
        $group_key: TENANT_ID,
        $group_set: { name: PII_NAME, status: 'active', created_at: OCCURRED_AT.toISOString() },
      },
    })
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
      auditRow('platform.member.auto_joined', { userId: TARGET_ID, emailDomain: 'example.test' }),
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

describe('buildTenantGroupIdentify', () => {
  it('builds the row on its own, for a caller with no audit row', () => {
    const row = buildTenantGroupIdentify(
      {
        id: TENANT_ID,
        name: 'Acme',
        status: 'suspended',
        createdAt: OCCURRED_AT,
        isPlatform: false,
      },
      {},
      'audit',
      'system',
      OCCURRED_AT
    )
    expect(row.properties).toMatchObject({
      $group_key: TENANT_ID,
      $group_set: { name: 'Acme', status: 'suspended' },
    })
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

    buildAuditEvents(
      auditRow('platform.member.auto_joined', { userId: TARGET_ID, emailDomain: PII_EMAIL }),
      {}
    )

    expect(warn).toHaveBeenCalledWith('Analytics properties dropped by the PII guard', {
      event: 'platform_member_auto_joined',
      droppedKeys: ['email_domain'],
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PII_EMAIL)
  })
})

/**
 * A seeded pseudo-random generator (mulberry32), so a failing case
 * reproduces on every run.
 * @param seed - The seed.
 * @returns A function returning a number in [0, 1).
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
 * samples whether or not the others run.
 * @param action - The audit action.
 * @returns A 32-bit seed.
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
  'success',
  'failure',
  'setup',
  'reset',
  ...MEMBERSHIP_ROLES,
  ...EMAIL_TEMPLATE_KEYS,
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
 * @param key - The metadata key.
 * @returns The candidate values.
 */
function candidatesFor(key: string): readonly unknown[] {
  if (key === 'slug') return [SLUG_PROBE]
  return PII_KEYS.has(key) ? BANNED_FIELD_CANDIDATES : CANDIDATES
}

/**
 * Up to `count` metadata objects that `schema` accepts, each field drawn
 * from the candidates its own schema accepts (a banned field from its own
 * candidates).
 * @param schema - An audit action's strict metadata schema.
 * @param random - The seeded generator.
 * @param count - How many to draw.
 * @returns The valid samples.
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
