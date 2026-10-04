/**
 * @file The fixed value sets of `audit_logs`, mirrored into its CHECK
 * constraints, and the metadata schema of every audited action.
 */
import { z } from 'zod'
import {
  ONBOARDING_STEP_KEY_MAX_LENGTH,
  ONBOARDING_STEP_KEY_PATTERN,
} from '@/constants/onboarding.constants'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
import { TIMELINE_RANGES, TIMELINE_VIEWS } from '@/constants/timeline.constants'
import { EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'
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
  'email_message',
  'email_suppression',
] as const

/**
 * One of `AUDIT_TARGET_TYPES`.
 */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

const role = z.enum(MEMBERSHIP_ROLES)
const id = z.string().min(1).max(36)
/**
 * A lowercase hostname only, so no address or token can reach the log.
 */
const emailDomain = z.string().regex(EMAIL_DOMAIN_PATTERN)
/**
 * Null when a stored address has no hostname domain, so the entry is still written.
 */
const invitationEmailDomain = emailDomain.nullable()
/**
 * Field names only, never their values.
 */
const changedFields = z.array(z.string().regex(/^[a-z][A-Za-z\d]{0,63}$/)).max(32)

/**
 * A staff member's stated reason for a state-changing action. `reasonSchema`
 * (platform.validators.ts) trims it and refuses control and bidi characters;
 * this re-checks only the bounds.
 */
const reason = z.string().min(1).max(500)

/**
 * An onboarding step key, in the registry's shape.
 */
const stepKey = z.string().max(ONBOARDING_STEP_KEY_MAX_LENGTH).regex(ONBOARDING_STEP_KEY_PATTERN)

/**
 * The range and view a staff member opened a timeline with.
 */
const timelineView = z.strictObject({
  range: z.enum(TIMELINE_RANGES),
  view: z.enum(TIMELINE_VIEWS),
})

/**
 * The most reminder emails one entry lists: one per active owner, bounded so
 * a runaway list cannot bloat the row.
 */
const MAX_REMINDER_RECIPIENTS = 1000

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
  'user.created': {
    target: 'user',
    metadata: z.strictObject({ emailDomain: invitationEmailDomain }),
  },
  'user.updated': { target: 'user', metadata: z.strictObject({ changed: changedFields }) },
  'user.deactivated': { target: 'user', metadata: z.strictObject({ reason }) },
  'user.reactivated': { target: 'user', metadata: z.strictObject({ reason }) },
  'user.signed_out': { target: 'user', metadata: z.strictObject({ reason }) },
  'user.password_setup_sent': {
    target: 'user',
    metadata: z.strictObject({ kind: z.enum(['setup', 'reset']) }),
  },
  'user.verification_resent': { target: 'user', metadata: z.strictObject({}) },
  'user.deleted': { target: 'user', metadata: z.strictObject({ reason }) },
  'tenant.suspended': { target: 'tenant', metadata: z.strictObject({ reason }) },
  'tenant.reactivated': { target: 'tenant', metadata: z.strictObject({ reason }) },
  'tenant.archived': { target: 'tenant', metadata: z.strictObject({ reason }) },
  'tenant.owner_invited': {
    target: 'invitation',
    metadata: z.strictObject({
      emailDomain: invitationEmailDomain,
      // The invitee's account when the address has one, so a staff self-invitation is visible.
      inviteeUserId: id.nullable(),
      // Null for the invitation sent when staff create the tenant; required on a re-issue.
      reason: reason.nullable(),
    }),
  },
  'auth.reauthenticated': {
    target: 'user',
    metadata: z.strictObject({ outcome: z.enum(['success', 'failure']) }),
  },
  'user.purged': {
    target: 'user',
    metadata: z.strictObject({ reason, emailDomain: invitationEmailDomain }),
  },
  'tenant.purged': {
    target: 'tenant',
    metadata: z.strictObject({
      reason,
      name: z.string().max(255),
      slug: z.string().max(100),
      memberCount: z.number().int().min(0),
    }),
  },
  'email.resent': {
    target: 'email_message',
    metadata: z.strictObject({
      reason,
      emailDomain: invitationEmailDomain,
      templateKey: z.enum(EMAIL_TEMPLATE_KEYS),
    }),
  },
  'email.suppression_lifted': {
    target: 'email_suppression',
    metadata: z.strictObject({ reason, emailDomain: invitationEmailDomain }),
  },
  'onboarding.dismissed': { target: 'tenant', metadata: z.strictObject({}) },
  'onboarding.undismissed': { target: 'tenant', metadata: z.strictObject({}) },
  'onboarding.step_completed': {
    target: 'tenant',
    metadata: z.strictObject({ reason, stepKey }),
  },
  'onboarding.reminder_sent': {
    target: 'tenant',
    metadata: z.strictObject({
      reason,
      recipientCount: z.number().int().min(0).max(MAX_REMINDER_RECIPIENTS),
      emailDomains: z.array(emailDomain).max(MAX_REMINDER_RECIPIENTS),
      messageIds: z.array(id).max(MAX_REMINDER_RECIPIENTS),
    }),
  },
  // A staff member opened the first page of a user's or a tenant's timeline.
  'user.timeline_viewed': { target: 'user', metadata: timelineView },
  'tenant.timeline_viewed': { target: 'tenant', metadata: timelineView },
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
