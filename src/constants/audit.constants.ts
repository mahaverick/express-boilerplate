/**
 * @file The fixed value sets of `audit_logs`, mirrored into its CHECK
 * constraints, and the metadata schema of every audited action.
 */
import { z } from 'zod'
import { BILLING_INTERVALS, MAX_TRIAL_DAYS, STAFF_CANCEL_WHEN } from '@/constants/billing.constants'
import { FRONTEND_APPS } from '@/constants/frontend.constants'
import { TAX_DETAIL_FIELDS, TAX_DOCUMENT_TYPES } from '@/constants/gst.constants'
import { MAINTENANCE_MODES } from '@/constants/maintenance-mode.constants'
import {
  ONBOARDING_STEP_KEY_MAX_LENGTH,
  ONBOARDING_STEP_KEY_PATTERN,
} from '@/constants/onboarding.constants'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
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
 * The kinds of record an audit entry can point at. `platform` is the
 * platform as a whole (maintenance mode), its id the platform tenant's;
 * `plan` is a plan row and `billing` a workspace's billing record.
 */
export const AUDIT_TARGET_TYPES = [
  'tenant',
  'membership',
  'invitation',
  'settings',
  'user',
  'email_message',
  'email_suppression',
  'platform',
  'plan',
  'billing',
  'tax_document',
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
 * A plan's columns staff can edit, as a plan edit's entry records them
 * before and after: no personal data, only the plan's own text and values.
 */
const entitlementKey = z.string().min(1).max(64)
const entitlementValue = z.union([z.boolean(), z.number().int(), z.null()])
const planSnapshot = z.strictObject({
  name: z.string().max(64),
  description: z.string().max(280),
  entitlements: z.record(entitlementKey, entitlementValue),
})

/**
 * Live customer tenants by billing state.
 */
const tenantStateCounts = z.strictObject({
  trialing: z.number().int().min(0),
  active: z.number().int().min(0),
  past_due: z.number().int().min(0),
  free: z.number().int().min(0),
})

/**
 * The reason on a member or invitation write: present when staff acted
 * through platform access, absent when a member did. Optional rather than
 * nullable, so a member's entry carries no `reason` key.
 */
const staffReason = reason.optional()

/**
 * An onboarding step key, in the registry's shape.
 */
const stepKey = z.string().max(ONBOARDING_STEP_KEY_MAX_LENGTH).regex(ONBOARDING_STEP_KEY_PATTERN)

/**
 * The most reminder emails one entry lists: one per active owner, bounded so
 * a runaway list cannot bloat the row.
 */
const MAX_REMINDER_RECIPIENTS = 1000

/**
 * Every audited action: the kind of record it targets and the strict schema
 * its `metadata` must match. `audit.service` rejects an entry whose metadata
 * does not match.
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
    metadata: z.strictObject({ userId: id, from: role, to: role, reason: staffReason }),
  },
  'member.removed': {
    target: 'membership',
    metadata: z.strictObject({ userId: id, role, self: z.boolean(), reason: staffReason }),
  },
  // A member left a tenant themselves (`DELETE /tenants/:slug/membership`).
  'member.left': { target: 'membership', metadata: z.strictObject({ role }) },
  'invitation.created': {
    target: 'invitation',
    metadata: z.strictObject({ role, emailDomain: invitationEmailDomain, reason: staffReason }),
  },
  // `trigger` marks a system resend made when the invitee asked Apex for a sign-in link. No longer written (that request now mails the confirm link), but kept so older rows still parse.
  'invitation.resent': {
    target: 'invitation',
    metadata: z.strictObject({
      role,
      emailDomain: invitationEmailDomain,
      reason: staffReason,
      trigger: z.literal('sign_in_request').optional(),
    }),
  },
  'invitation.revoked': {
    target: 'invitation',
    metadata: z.strictObject({ role, emailDomain: invitationEmailDomain, reason: staffReason }),
  },
  'invitation.accepted': {
    target: 'membership',
    metadata: z.strictObject({ role, invitationId: id }),
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
  // A staff member mailed the user a sign-in link; `app` is the frontend it opens.
  'user.sign_in_link_sent': {
    target: 'user',
    metadata: z.strictObject({ app: z.enum(FRONTEND_APPS) }),
  },
  // A user created or deleted a passkey. `passkeyId` is the row id, never the credential ID; `provider` is the authenticator's listed name.
  'user.passkey_created': {
    target: 'user',
    metadata: z.strictObject({
      passkeyId: id,
      provider: z.string().max(100),
      app: z.enum(FRONTEND_APPS),
    }),
  },
  'user.passkey_deleted': {
    target: 'user',
    metadata: z.strictObject({
      passkeyId: id,
      provider: z.string().max(100),
      app: z.enum(FRONTEND_APPS),
    }),
  },
  // A claim of a never-verified account deleted the passkeys on it. Only the count: no row id, no credential ID.
  'user.passkeys_cleared_on_claim': {
    target: 'user',
    metadata: z.strictObject({ count: z.number().int().positive() }),
  },
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
  // A step-up by any signed-in user, confirmed by an emailed link or a passkey. Rows written before Google step-up was removed keep `method: 'google'`: metadata is checked only on write.
  'auth.step_up_confirmed': {
    target: 'user',
    metadata: z.strictObject({ method: z.enum(['link', 'passkey']) }),
  },
  // Nothing writes this today (a link confirm no longer checks for staff, and passkey refusals are not audited); the action stays so old rows read back.
  'auth.step_up_refused': {
    target: 'user',
    metadata: z.strictObject({ method: z.literal('link') }),
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
  // An owner started a checkout for Paid: a new subscription, or a resubscribe while cancelling.
  'billing.checkout_started': {
    target: 'billing',
    metadata: z.strictObject({ interval: z.enum(BILLING_INTERVALS) }),
  },
  // An owner cancelled Paid: at the period end, or at once for a first charge still to come.
  'billing.cancel_scheduled': { target: 'billing', metadata: z.strictObject({}) },
  'billing.interval_switch_scheduled': {
    target: 'billing',
    metadata: z.strictObject({ interval: z.enum(BILLING_INTERVALS) }),
  },
  'billing.card_change_started': { target: 'billing', metadata: z.strictObject({}) },
  // The billing job marked a staff grant lapsed at its expiry; the actor is the system.
  'billing.grant_expired': {
    target: 'billing',
    metadata: z.strictObject({ grantId: id, key: z.string().min(1).max(64) }),
  },
  // A staff member read a tenant's billing in Apex; platform-billing.service.ts throttles it.
  'billing.viewed': { target: 'billing', metadata: z.strictObject({}) },
  // Staff synced a tenant's billing with the payment provider.
  'billing.resynced': { target: 'billing', metadata: z.strictObject({ reason }) },
  // Staff extended a tenant's trial, or put a Free tenant back on one; `trialEndsAt` is the new end.
  'billing.trial_extended': {
    target: 'billing',
    metadata: z.strictObject({
      days: z.number().int().min(1).max(MAX_TRIAL_DAYS),
      reason,
      trialEndsAt: z.iso.datetime(),
    }),
  },
  'billing.grant_added': {
    target: 'billing',
    metadata: z.strictObject({
      key: z.string().min(1).max(64),
      value: z.union([z.boolean(), z.number().int().min(1), z.null()]),
      expiresAt: z.iso.datetime().nullable(),
      reason,
    }),
  },
  'billing.grant_revoked': {
    target: 'billing',
    metadata: z.strictObject({ key: z.string().min(1).max(64), reason }),
  },
  // Staff cancelled a tenant's subscription: at its cycle end, or now.
  'billing.cancelled_by_staff': {
    target: 'billing',
    metadata: z.strictObject({ when: z.enum(STAFF_CANCEL_WHEN), reason }),
  },
  // An owner, or staff with a reason, saved a workspace's tax details; the changed field names only, never their values.
  'billing.tax_details_updated': {
    target: 'billing',
    metadata: z.strictObject({
      changedFields: z.array(z.enum(TAX_DETAIL_FIELDS)).min(1).max(TAX_DETAIL_FIELDS.length),
      reason: reason.optional(),
    }),
  },
  // The tax job issued an invoice or a credit note for a refund; the actor is the system.
  'billing.tax_document_issued': {
    target: 'tax_document',
    metadata: z.strictObject({ type: z.enum(TAX_DOCUMENT_TYPES) }),
  },
  // Staff issued a credit note by hand against an invoice; the target is the new note.
  'billing.credit_note_issued_by_staff': {
    target: 'tax_document',
    metadata: z.strictObject({ invoiceId: id, reason }),
  },
  // Staff recorded that they issued a held SEZ charge's invoice by hand; nothing is issued.
  'billing.held_charge_resolved': {
    target: 'billing',
    metadata: z.strictObject({ heldChargeId: id, reason }),
  },
  // Staff edited a plan's name, description or entitlements; `affected` counts the tenants on it by stored state.
  'plan.updated': {
    target: 'plan',
    metadata: z.strictObject({
      before: planSnapshot,
      after: planSnapshot,
      affected: tenantStateCounts,
      reason,
    }),
  },
  // Staff added a price to a plan, which retired the active price of its interval.
  'plan.price_created': {
    target: 'plan',
    metadata: z.strictObject({
      interval: z.enum(BILLING_INTERVALS),
      amountMinor: z.number().int().positive(),
      reason,
    }),
  },
  // Staff changed the platform-wide trial or grace settings; the field names only.
  'billing.settings_updated': {
    target: 'platform',
    metadata: z.strictObject({ changedFields, reason }),
  },
  // Staff downloaded a month or quarter of tax documents as GSTR-1 CSVs; the period only.
  'billing.tax_export_downloaded': {
    target: 'platform',
    metadata: z.strictObject({ period: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])$/) }),
  },
  // A staff member evaluated a user's flags in Apex; platform-flags.service.ts throttles it. Not `app`: the forwarded event's own `app` property would overwrite it.
  'user.flags_evaluated': {
    target: 'user',
    metadata: z.strictObject({ tenantId: id.nullable(), clientApp: z.enum(['react', 'apex']) }),
  },
  // The platform owner changed maintenance mode; `reason` is the reason sent with the change (null when none was sent, which may leave a stored reason in place), and `reasonChanged` says whether the stored reason differs from before.
  'platform.maintenance_mode_changed': {
    target: 'platform',
    metadata: z.strictObject({
      from: z.enum(MAINTENANCE_MODES),
      to: z.enum(MAINTENANCE_MODES),
      reason: reason.nullable(),
      messageChanged: z.boolean(),
      reasonChanged: z.boolean(),
    }),
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
 * Actions no build writes any more, whose rows stay in `audit_logs` (retention
 * keeps the log forever by default). They are listed and filterable, never
 * written.
 */
export const RETIRED_AUDIT_ACTIONS = [
  'user.timeline_viewed',
  'tenant.timeline_viewed',
  'user.errors_viewed',
  'tenant.errors_viewed',
  'platform.member.auto_joined',
  'auth.reauthenticated',
  'user.password_setup_sent',
  'user.verification_resent',
] as const

/**
 * Every action a stored row may hold: the written actions and the retired ones.
 */
export type StoredAuditAction = AuditAction | (typeof RETIRED_AUDIT_ACTIONS)[number]

/**
 * The stored actions, as a non-empty tuple for `z.enum`: what a list filter accepts.
 */
export const STORED_AUDIT_ACTION_NAMES: [StoredAuditAction, ...StoredAuditAction[]] = [
  ...AUDIT_ACTION_NAMES,
  ...RETIRED_AUDIT_ACTIONS,
]

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
