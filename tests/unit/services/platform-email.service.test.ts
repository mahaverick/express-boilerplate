/**
 * @file The pure parts of the staff email service: the rate rule, the
 * preview's variable assembly (rendered through the real templates), and
 * `canResendFor`'s matrix. No database.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { PlatformEmailRecord } from '@/repositories/platform-email.repository'
import { renderForMessage } from '@/services/mailer.service'
import {
  buildPreviewMessage,
  canResendFor,
  INVITER_NAME_PLACEHOLDER,
  rateOf,
  TOKEN_MASK,
  type ResendContext,
} from '@/services/platform-email.service'
import type { EmailTemplateKey } from '@/utilities/email-template.utilities'

const ORIGIN = 'https://apex.example.test'
const HEX_TOKEN = /[\da-f]{64}/

describe('rateOf', () => {
  it('is the fraction when knowable and the denominator is positive', () => {
    expect(rateOf(1, 4, true)).toEqual({ value: 0.25, numerator: 1, denominator: 4 })
  })

  it('is null with no denominator, and for an unknowable rate', () => {
    expect(rateOf(0, 0, true).value).toBeNull()
    expect(rateOf(3, 4, false)).toMatchObject({ numerator: 3, denominator: 4 })
    expect(rateOf(3, 4, false).value).toBeNull()
  })
})

describe('buildPreviewMessage', () => {
  it.each<[EmailTemplateKey, string]>([
    ['email_verification', '/verify-email?token='],
    ['password_reset', '/reset-password?token='],
    ['account_setup', '/reset-password?token='],
    ['tenant_invitation', '/invitations/accept?token='],
  ])('%s keeps the real page and frontend and masks the token', (templateKey, path) => {
    const { message } = buildPreviewMessage(templateKey, {}, ORIGIN)
    const rendered = renderForMessage(message)

    expect(rendered.text).toContain(`${ORIGIN}${path}${TOKEN_MASK}`)
    expect(rendered.html).not.toMatch(HEX_TOKEN)
    expect(rendered.text).not.toMatch(HEX_TOKEN)
  })

  it('uses the stored first name and product name and is not partial', () => {
    const { message, isPartial } = buildPreviewMessage(
      'password_reset',
      { firstName: 'Ada', appName: 'Acme' },
      ORIGIN
    )
    const rendered = renderForMessage(message)

    expect(isPartial).toBe(false)
    expect(rendered.text).toContain('Ada')
    expect(rendered.subject).toContain('Acme')
  })

  it('is partial when a stored variable is missing (a legacy row), filling it with the mask', () => {
    const { message, isPartial } = buildPreviewMessage('password_changed', {}, ORIGIN)

    expect(isPartial).toBe(true)
    expect(renderForMessage(message).text).toContain(TOKEN_MASK)
  })

  it('never uses a stored secret, even one that reached the row', () => {
    const leaked = `${ORIGIN}/reset-password?token=${'ab'.repeat(32)}`
    const { message } = buildPreviewMessage(
      'password_reset',
      { firstName: 'Ada', appName: 'Acme', resetUrl: leaked },
      ORIGIN
    )
    const rendered = renderForMessage(message)

    expect(rendered.text).not.toContain(leaked)
    expect(rendered.html).not.toMatch(HEX_TOKEN)
  })

  it('names the inviter "A teammate" and is not partial when every stored variable is present', () => {
    const { message, isPartial } = buildPreviewMessage(
      'tenant_invitation',
      { tenantName: 'Acme', role: 'editor', expiresInDays: '7', appName: 'Acme' },
      ORIGIN
    )

    expect(isPartial).toBe(false)
    expect(renderForMessage(message).text).toContain(`${INVITER_NAME_PLACEHOLDER} invited you`)
  })

  it('marks an invitation partial only when a stored variable is missing', () => {
    const { isPartial } = buildPreviewMessage('tenant_invitation', {}, ORIGIN)
    expect(isPartial).toBe(true)
  })

  it('ignores a non-string stored value', () => {
    const { isPartial } = buildPreviewMessage(
      'registration_attempt',
      { firstName: 42, appName: 'Acme' },
      ORIGIN
    )
    expect(isPartial).toBe(true)
  })
})

const ACTOR = { userId: randomUUID() }

function message(overrides: Partial<PlatformEmailRecord> = {}): PlatformEmailRecord {
  const userId = randomUUID()
  return {
    id: randomUUID(),
    recipient: 'Ada@Example.test',
    templateKey: 'account_setup',
    status: 'sent',
    senderClass: 'transactional',
    linkApp: 'web',
    // eslint-disable-next-line unicorn/no-null -- the column is nullable
    failureOrigin: null,
    userId,
    // eslint-disable-next-line unicorn/no-null -- no tenant
    tenantId: null,
    // eslint-disable-next-line unicorn/no-null -- no invitation
    invitationId: null,
    // eslint-disable-next-line unicorn/no-null -- not a resend
    resentFromId: null,
    createdAt: new Date(),
    statusUpdatedAt: new Date(),
    user: {
      id: userId,
      email: 'ada@example.test',
      firstName: 'Ada',
      // eslint-disable-next-line unicorn/no-null -- no last name
      lastName: null,
      isActive: true,
      isVerified: true,
      // eslint-disable-next-line unicorn/no-null -- a live user
      deletedAt: null,
    },
    // eslint-disable-next-line unicorn/no-null -- no tenant
    tenant: null,
    ...overrides,
  }
}

function context(overrides: Partial<ResendContext> = {}): ResendContext {
  return {
    actorPlatformRole: 'admin',
    targetPlatformRoles: new Map(),
    actorMembershipRoles: new Map(),
    invitations: new Map(),
    suppressedAddresses: new Set(),
    ...overrides,
  }
}

describe('canResendFor', () => {
  it('is true for an admin resending a non-staff user their set-password mail', () => {
    expect(canResendFor(ACTOR, message(), context())).toBe(true)
  })

  // eslint-disable-next-line unicorn/no-null -- no longer staff
  it.each<MembershipRole | null>(['viewer', 'editor', 'manager', null])(
    'is false for a %s',
    (role) => {
      expect(canResendFor(ACTOR, message(), context({ actorPlatformRole: role }))).toBe(false)
    }
  )

  it.each(['password_changed', 'registration_attempt', 'retired_template'])(
    'is false for %s (no resend action)',
    (templateKey) => {
      expect(canResendFor(ACTOR, message({ templateKey }), context())).toBe(false)
    }
  )

  it('is false for a suppressed address, matched case-insensitively', () => {
    const suppressed = context({ suppressedAddresses: new Set(['ada@example.test']) })
    expect(canResendFor(ACTOR, message(), suppressed)).toBe(false)
  })

  it('is false for a legacy row without a user, and for a soft-deleted user', () => {
    // eslint-disable-next-line unicorn/no-null -- a backfilled row has no user
    const legacy = message({ userId: null, user: null })
    expect(canResendFor(ACTOR, legacy, context())).toBe(false)
    const gone = message()
    if (gone.user) gone.user.deletedAt = new Date()
    expect(canResendFor(ACTOR, gone, context())).toBe(false)
  })

  it('is false for a verification resend to an already-verified user, true while unverified', () => {
    const verified = message({ templateKey: 'email_verification' })
    expect(canResendFor(ACTOR, verified, context())).toBe(false)
    const unverified = message({ templateKey: 'email_verification' })
    if (unverified.user) unverified.user.isVerified = false
    expect(canResendFor(ACTOR, unverified, context())).toBe(true)
  })

  it('is true for a set-password resend to a verified user', () => {
    expect(canResendFor(ACTOR, message({ templateKey: 'password_reset' }), context())).toBe(true)
  })

  it.each(['email_verification', 'account_setup', 'password_reset'])(
    'is false for %s to a deactivated user',
    (templateKey) => {
      const inactive = message({ templateKey })
      // Unverified too, so only `isActive` can refuse
      if (inactive.user) Object.assign(inactive.user, { isActive: false, isVerified: false })
      expect(canResendFor(ACTOR, inactive, context())).toBe(false)
    }
  )

  it('is false when the target outranks the actor, true for an owner', () => {
    const staffOwner = message()
    const roles = new Map<string, MembershipRole>([[staffOwner.userId ?? '', 'owner']])
    expect(canResendFor(ACTOR, staffOwner, context({ targetPlatformRoles: roles }))).toBe(false)
    expect(
      canResendFor(
        ACTOR,
        staffOwner,
        context({ targetPlatformRoles: roles, actorPlatformRole: 'owner' })
      )
    ).toBe(true)
  })

  describe('invitations', () => {
    const tenantId = randomUUID()
    const invitationId = randomUUID()
    const invitation = message({ templateKey: 'tenant_invitation', tenantId, invitationId })

    it('follows canActorGrantRole on the invitation role', () => {
      const editor = new Map([
        [invitationId, { id: invitationId, tenantId, role: 'editor' as const }],
      ])
      const admin = new Map([
        [invitationId, { id: invitationId, tenantId, role: 'admin' as const }],
      ])

      expect(canResendFor(ACTOR, invitation, context({ invitations: editor }))).toBe(true)
      expect(canResendFor(ACTOR, invitation, context({ invitations: admin }))).toBe(false)
      expect(
        canResendFor(ACTOR, invitation, context({ invitations: admin, actorPlatformRole: 'owner' }))
      ).toBe(true)
    })

    it("uses the actor's membership in the tenant before their platform role", () => {
      const admin = new Map([
        [invitationId, { id: invitationId, tenantId, role: 'admin' as const }],
      ])
      const ownerThere = new Map<string, MembershipRole>([[tenantId, 'owner']])

      expect(
        canResendFor(
          ACTOR,
          invitation,
          context({ invitations: admin, actorMembershipRoles: ownerThere })
        )
      ).toBe(true)
    })

    it('is false without the ids, or when the invitation is gone or in another tenant', () => {
      // eslint-disable-next-line unicorn/no-null -- a backfilled row has no invitation id
      expect(canResendFor(ACTOR, message({ ...invitation, invitationId: null }), context())).toBe(
        false
      )
      expect(canResendFor(ACTOR, invitation, context())).toBe(false)
      const elsewhere = new Map([
        [invitationId, { id: invitationId, tenantId: randomUUID(), role: 'viewer' as const }],
      ])
      expect(canResendFor(ACTOR, invitation, context({ invitations: elsewhere }))).toBe(false)
    })
  })
})
