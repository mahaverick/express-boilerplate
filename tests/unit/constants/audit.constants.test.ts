// tests/unit/constants/audit.constants.test.ts
//
// Pins the audited actions to the API contract, to audit_logs_action_check's
// pattern and column width, and each metadata schema to its exact keys.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AUDIT_ACCESS_KINDS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_TARGET_TYPES,
  PLATFORM_ACCESS_DEDUPE_SECONDS,
  type AuditAction,
} from '@/constants/audit.constants'

// A valid metadata object per action, written out so a shape change fails here.
const VALID_METADATA: Record<AuditAction, Record<string, unknown>> = {
  'tenant.created': { name: 'Acme Inc', slug: 'acme' },
  'tenant.updated': { changed: ['name', 'description'] },
  'tenant.settings_updated': { changed: ['timezone'] },
  'member.role_changed': { userId: 'user-1', from: 'viewer', to: 'editor' },
  'member.removed': { userId: 'user-1', role: 'editor', self: false },
  'invitation.created': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.resent': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.revoked': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.accepted': { role: 'viewer', invitationId: 'invitation-1' },
  'platform.member.auto_joined': { userId: 'user-1', emailDomain: 'staff.example.test' },
  'platform.member.granted': { userId: 'user-1', role: 'admin', via: 'script' },
  'tenant.accessed_by_platform': { platformRole: 'viewer' },
}

const ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[]

describe('AUDIT_ACTIONS', () => {
  it('lists exactly the actions of the API contract', () => {
    expect(ACTIONS.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'invitation.accepted',
      'invitation.created',
      'invitation.resent',
      'invitation.revoked',
      'member.removed',
      'member.role_changed',
      'platform.member.auto_joined',
      'platform.member.granted',
      'tenant.accessed_by_platform',
      'tenant.created',
      'tenant.settings_updated',
      'tenant.updated',
    ])
  })

  it.each(ACTIONS)('%s fits audit_logs_action_check and varchar(64)', (action) => {
    expect(action).toMatch(/^[a-z]+(\.[a-z_]+)+$/)
    expect(action.length).toBeLessThanOrEqual(64)
  })

  it.each(ACTIONS)('%s targets a known target type', (action) => {
    expect(AUDIT_TARGET_TYPES).toContain(AUDIT_ACTIONS[action].target)
  })

  it.each(ACTIONS)('%s accepts its documented metadata', (action) => {
    expect(AUDIT_ACTIONS[action].metadata.safeParse(VALID_METADATA[action]).success).toBe(true)
  })

  it.each(ACTIONS)('%s rejects an unknown metadata key (strict)', (action) => {
    const withExtra = { ...VALID_METADATA[action], email: 'ada@example.test' }
    expect(AUDIT_ACTIONS[action].metadata.safeParse(withExtra).success).toBe(false)
  })

  it.each(ACTIONS)('%s rejects metadata with a key missing', (action) => {
    const [firstKey] = Object.keys(VALID_METADATA[action])
    const missing = Object.fromEntries(
      Object.entries(VALID_METADATA[action]).filter(([key]) => key !== firstKey)
    )
    expect(AUDIT_ACTIONS[action].metadata.safeParse(missing).success).toBe(false)
  })

  it('refuses a full address where only the domain may go', () => {
    const schema = AUDIT_ACTIONS['invitation.created'].metadata
    expect(schema.safeParse({ role: 'viewer', emailDomain: 'ada@example.test' }).success).toBe(
      false
    )
  })

  it('refuses a changed-fields list that carries values instead of names', () => {
    const schema = AUDIT_ACTIONS['tenant.updated'].metadata
    expect(schema.safeParse({ changed: ['name=Acme Inc'] }).success).toBe(false)
  })

  it('refuses a role outside MEMBERSHIP_ROLES', () => {
    const schema = AUDIT_ACTIONS['tenant.accessed_by_platform'].metadata
    expect(schema.safeParse({ platformRole: 'superuser' }).success).toBe(false)
  })
})

describe('emailDomain shape', () => {
  const schema = AUDIT_ACTIONS['invitation.created'].metadata

  it('accepts a lowercase hostname', () => {
    expect(schema.safeParse({ role: 'viewer', emailDomain: 'example.com' }).success).toBe(true)
  })

  it.each([
    ['a hex token with no dot', 'a1b2c3d4'.repeat(8)],
    ['a full address', 'a@b.com'],
    ['an upper-case domain', 'EXAMPLE.COM'],
    ['a bare hostname with no TLD', 'localhost'],
  ])('refuses %s', (_label, emailDomain) => {
    expect(schema.safeParse({ role: 'viewer', emailDomain }).success).toBe(false)
  })
})

describe('audit value sets', () => {
  it('match the audit_logs CHECK constraints', () => {
    expect(AUDIT_ACTOR_KINDS).toEqual(['user', 'system'])
    expect(AUDIT_ACCESS_KINDS).toEqual(['member', 'platform', 'system'])
    expect(AUDIT_TARGET_TYPES).toEqual(['tenant', 'membership', 'invitation', 'settings', 'user'])
  })

  it('dedupes platform access for one hour', () => {
    expect(PLATFORM_ACCESS_DEDUPE_SECONDS).toBe(3600)
  })

  it('exposes the audited actions as a z.enum-ready tuple', () => {
    expect(AUDIT_ACTION_NAMES.toSorted((a, b) => a.localeCompare(b))).toEqual(
      ACTIONS.toSorted((a, b) => a.localeCompare(b))
    )
    const schema = z.enum(AUDIT_ACTION_NAMES)
    for (const action of ACTIONS) expect(schema.safeParse(action).success).toBe(true)
    expect(schema.safeParse('not.an.action').success).toBe(false)
  })
})
