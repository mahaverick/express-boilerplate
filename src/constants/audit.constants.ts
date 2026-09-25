// src/constants/audit.constants.ts
//
// The fixed value sets of `audit_logs`, mirrored into its CHECK constraints,
// and the metadata schema of every audited action.
import { z } from 'zod'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
import { EMAIL_DOMAIN_PATTERN } from '@/utilities/email.utilities'

/**
 * Who performed an audited action: a signed-in user, or the system (a script).
 */
export const AUDIT_ACTOR_KINDS = ['user', 'system'] as const

/**
 * One of `AUDIT_ACTOR_KINDS`.
 */
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

/**
 * How the actor reached the tenant: as a member, through platform access, or as the system.
 */
export const AUDIT_ACCESS_KINDS = ['member', 'platform', 'system'] as const

/**
 * One of `AUDIT_ACCESS_KINDS`.
 */
export type AuditAccess = (typeof AUDIT_ACCESS_KINDS)[number]

/**
 * The kinds of record an audit entry can point at.
 */
export const AUDIT_TARGET_TYPES = [
  'tenant',
  'membership',
  'invitation',
  'settings',
  'user',
] as const

/**
 * One of `AUDIT_TARGET_TYPES`.
 */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

const role = z.enum(MEMBERSHIP_ROLES)
const id = z.string().min(1).max(36)
// A lowercase hostname only: an address, a mixed-case value, or a token
// (no dot) must never reach the log. The producer lowercases first.
const emailDomain = z.string().regex(EMAIL_DOMAIN_PATTERN)
// Null for a stored invitation address whose domain is no hostname, so the
// entry is still written without it.
const invitationEmailDomain = emailDomain.nullable()
// Field names only, never their values.
const changedFields = z.array(z.string().regex(/^[a-z][A-Za-z\d]{0,63}$/)).max(32)

/**
 * Every audited action: the kind of record it targets and the strict schema
 * its `metadata` must match. `audit.service.record` rejects anything else.
 */
export const AUDIT_ACTIONS = {
  'tenant.created': {
    target: 'tenant',
    metadata: z.strictObject({ name: z.string().max(255), slug: z.string().max(100) }),
  },
  'tenant.updated': { target: 'tenant', metadata: z.strictObject({ changed: changedFields }) },
  'tenant.settings_updated': {
    target: 'settings',
    metadata: z.strictObject({ changed: changedFields }),
  },
  'member.role_changed': {
    target: 'membership',
    metadata: z.strictObject({ userId: id, from: role, to: role }),
  },
  'member.removed': {
    target: 'membership',
    metadata: z.strictObject({ userId: id, role, self: z.boolean() }),
  },
  'invitation.created': {
    target: 'invitation',
    metadata: z.strictObject({ role, emailDomain: invitationEmailDomain }),
  },
  'invitation.resent': {
    target: 'invitation',
    metadata: z.strictObject({ role, emailDomain: invitationEmailDomain }),
  },
  'invitation.revoked': {
    target: 'invitation',
    metadata: z.strictObject({ role, emailDomain: invitationEmailDomain }),
  },
  'invitation.accepted': {
    target: 'membership',
    metadata: z.strictObject({ role, invitationId: id }),
  },
  'platform.member.auto_joined': {
    target: 'membership',
    metadata: z.strictObject({ userId: id, emailDomain }),
  },
  'platform.member.granted': {
    target: 'membership',
    metadata: z.strictObject({ userId: id, role, via: z.literal('script') }),
  },
  'tenant.accessed_by_platform': {
    target: 'tenant',
    metadata: z.strictObject({ platformRole: role }),
  },
} as const satisfies Record<string, { target: AuditTargetType; metadata: z.ZodType }>

/**
 * One of the audited actions.
 */
export type AuditAction = keyof typeof AUDIT_ACTIONS

/**
 * The audited actions, as a non-empty tuple for `z.enum`.
 */
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]]

/**
 * The metadata shape one action requires.
 */
export type AuditMetadata<TAction extends AuditAction> = z.infer<
  (typeof AUDIT_ACTIONS)[TAction]['metadata']
>

/**
 * How long one staff user's visits to one tenant are deduplicated (`SET NX EX`).
 */
export const PLATFORM_ACCESS_DEDUPE_SECONDS = 3600
