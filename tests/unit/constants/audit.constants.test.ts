/**
 * @file Pins the audited actions to the API contract, to
 * audit_logs_action_check's pattern and column width, and each metadata
 * schema to its exact keys.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  AUDIT_ACCESS_KINDS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_TARGET_TYPES,
  PLATFORM_ACCESS_DEDUPE_SECONDS,
  RETIRED_AUDIT_ACTIONS,
  STORED_AUDIT_ACTION_NAMES,
  type AuditAction,
} from '@/constants/audit.constants'
import type { AuditEntry } from '@/services/audit.service'

// A valid metadata object per action, written out so a shape change fails here.
const VALID_METADATA: Record<AuditAction, Record<string, unknown>> = {
  'tenant.created': { name: 'Acme Inc', slug: 'acme' },
  'tenant.updated': { changed: ['name', 'description'] },
  'tenant.settings_updated': { changed: ['timezone'] },
  'member.role_changed': { userId: 'user-1', from: 'viewer', to: 'editor' },
  'member.removed': { userId: 'user-1', role: 'editor', self: false },
  'member.left': { role: 'viewer' },
  'invitation.created': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.resent': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.revoked': { role: 'viewer', emailDomain: 'example.test' },
  'invitation.accepted': { role: 'viewer', invitationId: 'invitation-1' },
  'platform.member.granted': { userId: 'user-1', role: 'admin', via: 'script' },
  'tenant.accessed_by_platform': { platformRole: 'viewer' },
  'user.created': { emailDomain: 'example.test' },
  'user.updated': { changed: ['firstName'] },
  'user.deactivated': { reason: 'Chargeback fraud, ticket 4411' },
  'user.reactivated': { reason: 'Cleared by support' },
  'user.signed_out': { reason: 'Lost laptop' },
  'user.sign_in_link_sent': { app: 'web' },
  'user.passkey_created': { passkeyId: 'passkey-1', provider: 'Apple Passwords', app: 'web' },
  'user.passkey_deleted': { passkeyId: 'passkey-1', provider: 'Apple Passwords', app: 'web' },
  'user.deleted': { reason: 'Erasure request' },
  'tenant.suspended': { reason: 'Unpaid invoice' },
  'tenant.reactivated': { reason: 'Invoice paid' },
  'tenant.archived': { reason: 'Contract ended' },
  'tenant.owner_invited': {
    emailDomain: 'example.test',
    inviteeUserId: 'user-2',
    reason: 'Customer asked us to resend',
  },
  'auth.step_up_confirmed': { method: 'link' },
  'auth.step_up_refused': { method: 'link' },
  'user.purged': { reason: 'Erasure request, ticket 9001', emailDomain: 'example.test' },
  'tenant.purged': { reason: 'Contract ended', name: 'Acme Inc', slug: 'acme', memberCount: 3 },
  'email.resent': {
    reason: 'Customer never got the link',
    emailDomain: 'example.test',
    templateKey: 'sign_in_link',
  },
  'email.suppression_lifted': { reason: 'Mailbox fixed, ticket 812', emailDomain: 'example.test' },
  'onboarding.dismissed': {},
  'onboarding.undismissed': {},
  'onboarding.step_completed': {
    reason: 'Customer configured it on a call',
    stepKey: 'configure_settings',
  },
  'onboarding.reminder_sent': {
    reason: 'Stuck for two weeks',
    recipientCount: 2,
    emailDomains: ['example.test', 'acme.example'],
    messageIds: ['message-1', 'message-2'],
  },
  // eslint-disable-next-line unicorn/no-null -- the metadata records JSON null for "no tenant"
  'user.flags_evaluated': { tenantId: null, clientApp: 'react' },
  'platform.maintenance_mode_changed': {
    from: 'off',
    to: 'full',
    reason: 'Database upgrade',
    messageChanged: true,
    reasonChanged: true,
  },
}

const ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[]

// An empty metadata object has no key to drop.
const ACTIONS_WITH_METADATA_KEYS = ACTIONS.filter(
  (action) => Object.keys(VALID_METADATA[action]).length > 0
)

describe('AUDIT_ACTIONS', () => {
  it('lists exactly the actions of the API contract', () => {
    expect(ACTIONS.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'auth.step_up_confirmed',
      'auth.step_up_refused',
      'email.resent',
      'email.suppression_lifted',
      'invitation.accepted',
      'invitation.created',
      'invitation.resent',
      'invitation.revoked',
      'member.left',
      'member.removed',
      'member.role_changed',
      'onboarding.dismissed',
      'onboarding.reminder_sent',
      'onboarding.step_completed',
      'onboarding.undismissed',
      'platform.maintenance_mode_changed',
      'platform.member.granted',
      'tenant.accessed_by_platform',
      'tenant.archived',
      'tenant.created',
      'tenant.owner_invited',
      'tenant.purged',
      'tenant.reactivated',
      'tenant.settings_updated',
      'tenant.suspended',
      'tenant.updated',
      'user.created',
      'user.deactivated',
      'user.deleted',
      'user.flags_evaluated',
      'user.passkey_created',
      'user.passkey_deleted',
      'user.purged',
      'user.reactivated',
      'user.sign_in_link_sent',
      'user.signed_out',
      'user.updated',
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

  it.each(ACTIONS_WITH_METADATA_KEYS)('%s rejects metadata with a key missing', (action) => {
    const [firstKey] = Object.keys(VALID_METADATA[action])
    const missing = Object.fromEntries(
      Object.entries(VALID_METADATA[action]).filter(([key]) => key !== firstKey)
    )
    expect(AUDIT_ACTIONS[action].metadata.safeParse(missing).success).toBe(false)
  })

  it.each([
    'user.deactivated',
    'user.reactivated',
    'user.signed_out',
    'user.deleted',
    'tenant.suspended',
    'tenant.reactivated',
    'tenant.archived',
    'tenant.owner_invited',
    'user.purged',
    'tenant.purged',
    'email.resent',
    'email.suppression_lifted',
    'onboarding.step_completed',
    'onboarding.reminder_sent',
  ] as const)('%s refuses an empty or over-long reason', (action) => {
    const schema = AUDIT_ACTIONS[action].metadata
    const valid = VALID_METADATA[action]
    expect(schema.safeParse({ ...valid, reason: '' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, reason: 'x'.repeat(501) }).success).toBe(false)
    expect(schema.safeParse({ ...valid, reason: 'x'.repeat(500) }).success).toBe(true)
  })

  it.each([
    'user.created',
    'tenant.owner_invited',
    'user.purged',
    'email.resent',
    'email.suppression_lifted',
  ] as const)('%s refuses a full address and accepts no domain', (action) => {
    const valid = VALID_METADATA[action]
    const schema = AUDIT_ACTIONS[action].metadata
    expect(schema.safeParse({ ...valid, emailDomain: 'ada@example.test' }).success).toBe(false)
    // eslint-disable-next-line unicorn/no-null -- the metadata records JSON null for "no domain"
    expect(schema.safeParse({ ...valid, emailDomain: null }).success).toBe(true)
  })

  it('lets tenant.owner_invited record no invitee account and no reason (the invitation sent at creation)', () => {
    const schema = AUDIT_ACTIONS['tenant.owner_invited'].metadata
    const valid = VALID_METADATA['tenant.owner_invited']
    // eslint-disable-next-line unicorn/no-null -- JSON null: the address has no account yet
    expect(schema.safeParse({ ...valid, inviteeUserId: null }).success).toBe(true)
    // eslint-disable-next-line unicorn/no-null -- JSON null: created with the tenant, no reason asked
    expect(schema.safeParse({ ...valid, reason: null }).success).toBe(true)
  })

  it('pins the closed value sets of user.sign_in_link_sent and the step-up actions', () => {
    expect(
      AUDIT_ACTIONS['user.sign_in_link_sent'].metadata.safeParse({ app: 'apex' }).success
    ).toBe(true)
    expect(
      AUDIT_ACTIONS['user.sign_in_link_sent'].metadata.safeParse({ app: 'mobile' }).success
    ).toBe(false)
    expect(AUDIT_ACTIONS['user.sign_in_link_sent'].metadata.safeParse({}).success).toBe(false)
    expect(
      AUDIT_ACTIONS['auth.step_up_confirmed'].metadata.safeParse({ method: 'google' }).success
    ).toBe(false)
    expect(
      AUDIT_ACTIONS['auth.step_up_confirmed'].metadata.safeParse({ method: 'password' }).success
    ).toBe(false)
    expect(
      AUDIT_ACTIONS['auth.step_up_refused'].metadata.safeParse({ method: 'link' }).success
    ).toBe(true)
    for (const action of ['auth.step_up_confirmed', 'auth.step_up_refused'] as const) {
      expect(AUDIT_ACTIONS[action].metadata.safeParse({ method: 'passkey' }).success).toBe(true)
    }
    expect(
      AUDIT_ACTIONS['auth.step_up_refused'].metadata.safeParse({ method: 'password' }).success
    ).toBe(false)
  })

  it('pins the closed value sets of the passkey actions', () => {
    for (const action of ['user.passkey_created', 'user.passkey_deleted'] as const) {
      const schema = AUDIT_ACTIONS[action].metadata
      const valid = VALID_METADATA[action]
      expect(AUDIT_ACTIONS[action].target).toBe('user')
      expect(schema.safeParse({ ...valid, app: 'mobile' }).success).toBe(false)
      expect(schema.safeParse({ ...valid, provider: 'x'.repeat(101) }).success).toBe(false)
      expect(schema.safeParse({ ...valid, credentialId: 'abc' }).success).toBe(false)
    }
  })

  it('records only a known template key on email.resent', () => {
    const schema = AUDIT_ACTIONS['email.resent'].metadata
    const valid = VALID_METADATA['email.resent']
    expect(schema.safeParse({ ...valid, templateKey: 'welcome' }).success).toBe(true)
    expect(schema.safeParse({ ...valid, templateKey: 'account_setup' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, templateKey: 'not_a_template' }).success).toBe(false)
  })

  it('targets email messages and suppressions', () => {
    expect(AUDIT_ACTIONS['email.resent'].target).toBe('email_message')
    expect(AUDIT_ACTIONS['email.suppression_lifted'].target).toBe('email_suppression')
  })

  it('files every onboarding action against the tenant', () => {
    expect(AUDIT_ACTIONS['onboarding.dismissed'].target).toBe('tenant')
    expect(AUDIT_ACTIONS['onboarding.undismissed'].target).toBe('tenant')
    expect(AUDIT_ACTIONS['onboarding.step_completed'].target).toBe('tenant')
    expect(AUDIT_ACTIONS['onboarding.reminder_sent'].target).toBe('tenant')
  })

  it.each(['Configure_Settings', 'configure-settings', `k${'a'.repeat(64)}`])(
    'onboarding.step_completed refuses the step key %j',
    (stepKey) => {
      const schema = AUDIT_ACTIONS['onboarding.step_completed'].metadata
      const valid = VALID_METADATA['onboarding.step_completed']
      expect(schema.safeParse({ ...valid, stepKey }).success).toBe(false)
    }
  )

  it('onboarding.reminder_sent records domains only, never an address', () => {
    const schema = AUDIT_ACTIONS['onboarding.reminder_sent'].metadata
    const valid = VALID_METADATA['onboarding.reminder_sent']
    expect(schema.safeParse({ ...valid, emailDomains: ['ada@example.test'] }).success).toBe(false)
    expect(schema.safeParse({ ...valid, emailDomains: [], messageIds: [] }).success).toBe(true)
    expect(schema.safeParse({ ...valid, recipientCount: -1 }).success).toBe(false)
  })

  it('targets users, tenants and invitations as the plan says', () => {
    expect(AUDIT_ACTIONS['user.deleted'].target).toBe('user')
    expect(AUDIT_ACTIONS['auth.step_up_confirmed'].target).toBe('user')
    expect(AUDIT_ACTIONS['auth.step_up_refused'].target).toBe('user')
    expect(AUDIT_ACTIONS['tenant.archived'].target).toBe('tenant')
    expect(AUDIT_ACTIONS['tenant.owner_invited'].target).toBe('invitation')
    expect(AUDIT_ACTIONS['user.purged'].target).toBe('user')
    expect(AUDIT_ACTIONS['tenant.purged'].target).toBe('tenant')
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

  it.each(['invitation.created', 'invitation.resent', 'invitation.revoked'] as const)(
    '%s accepts a null domain, for a stored address that has no hostname',
    (action) => {
      expect(
        // eslint-disable-next-line unicorn/no-null -- the metadata records JSON null for "no domain"
        AUDIT_ACTIONS[action].metadata.safeParse({ role: 'viewer', emailDomain: null }).success
      ).toBe(true)
    }
  )

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
    expect(AUDIT_TARGET_TYPES).toEqual([
      'tenant',
      'membership',
      'invitation',
      'settings',
      'user',
      'email_message',
      'email_suppression',
      'platform',
    ])
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

  it('lets invitation.resent name the sign-in request that triggered it, and nothing else', () => {
    const resent = AUDIT_ACTIONS['invitation.resent'].metadata
    const base = { role: 'viewer', emailDomain: 'example.test' }
    expect(resent.safeParse({ ...base, trigger: 'sign_in_request' }).success).toBe(true)
    expect(resent.safeParse({ ...base, trigger: 'staff' }).success).toBe(false)
  })

  describe('retired actions', () => {
    it('are stored and filterable but not written', () => {
      expect(RETIRED_AUDIT_ACTIONS).toEqual([
        'user.timeline_viewed',
        'tenant.timeline_viewed',
        'user.errors_viewed',
        'tenant.errors_viewed',
        'platform.member.auto_joined',
        'auth.reauthenticated',
        'user.password_setup_sent',
        'user.verification_resent',
      ])
      for (const action of RETIRED_AUDIT_ACTIONS) {
        expect(Object.hasOwn(AUDIT_ACTIONS, action)).toBe(false)
        expect(AUDIT_ACTION_NAMES).not.toContain(action)
        expect(STORED_AUDIT_ACTION_NAMES).toContain(action)
        expect(action).toMatch(/^[a-z]+(\.[a-z_]+)+$/)
      }
      expect(STORED_AUDIT_ACTION_NAMES).toHaveLength(
        AUDIT_ACTION_NAMES.length + RETIRED_AUDIT_ACTIONS.length
      )
    })

    it('cannot be recorded: an entry for one does not type-check', () => {
      expectTypeOf<(typeof RETIRED_AUDIT_ACTIONS)[number]>().not.toExtend<AuditEntry['action']>()
    })
  })
})
