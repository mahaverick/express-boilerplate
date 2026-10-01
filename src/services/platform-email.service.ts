/**
 * @file Staff message tracking, behind `/platform/emails` and
 * `/platform/email-suppressions`: search, detail, preview, health, resend
 * and lifting a suppression. The routes check the caller's platform role
 * before any of this runs. A resend never replays a stored email: it runs
 * the SP2 action that sent it, which issues a fresh token, with that
 * action's own gates, errors and audit entry. The only importer of
 * `platform-email.repository.ts`.
 */
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import {
  EMAIL_MESSAGE_GROUPS,
  type EmailMessageGroup,
  type EmailMessageStatus,
} from '@/constants/email.constants'
import type { StatsRange } from '@/constants/platform.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { canActorGrantRole, canStaffMailTarget, isRoleAtLeast } from '@/policies/tenant.policy'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import {
  PlatformEmailRepository,
  type EmailPageCursor,
  type EmailUserRow,
  type PlatformEmailRecord,
  type PlatformSuppressionRecord,
  type ResendInvitationRow,
} from '@/repositories/platform-email.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { renderForMessage, type MailMessage } from '@/services/mailer.service'
import { utcDays } from '@/services/platform-stats.service'
import {
  platformTenantOrThrow,
  resendUserVerification,
  sendPasswordSetup,
} from '@/services/platform-user.service'
import { assertStillPlatformRole, getPlatformMembership } from '@/services/platform.service'
import { resend as resendInvitation } from '@/services/tenant-invitation.service'
import {
  buildInvitationAcceptUrl,
  buildPasswordResetUrl,
  buildVerificationUrl,
  frontendUrl,
} from '@/services/verification.service'
import { EMAIL_TEMPLATE_META } from '@/templates/email/email-template-meta.template'
import type { Actor } from '@/types/actor'
import type { EmailDelivery } from '@/types/email-delivery'
import type {
  EmailGroupCounts,
  EmailHealth,
  EmailMessageDetail,
  EmailMessagePage,
  EmailMessageSummary,
  EmailPerson,
  EmailPreview,
  EmailRate,
  EmailSuppressionPage,
  EmailSuppressionView,
} from '@/types/platform-email'
import { encodeCursor } from '@/utilities/cursor.utilities'
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
  type ResendAction,
} from '@/utilities/email-template.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'
import { isRecentAuth } from '@/utilities/recent-auth.utilities'
import type {
  PlatformEmailSearchQuery,
  PlatformSuppressionSearchQuery,
} from '@/validators/platform-email.validators'

const platformEmailRepository = new PlatformEmailRepository()
const emailSuppressionRepository = new EmailSuppressionRepository()

/**
 * What a preview shows in place of a link's token.
 */
export const TOKEN_MASK = '••••••'

/**
 * What a preview shows for the inviter, whose name is never stored.
 */
export const INVITER_NAME_PLACEHOLDER = 'A teammate'

/**
 * Error code: the message's template is not in this build's registry.
 */
export const TEMPLATE_UNAVAILABLE_CODE = 'template_unavailable'

/**
 * Error code: the message cannot be resent (a security notice, or a row
 * without the ids its action needs).
 */
export const NOT_RESENDABLE_CODE = 'not_resendable'

/**
 * Error code: the recipient's address is suppressed.
 */
export const RECIPIENT_SUPPRESSED_CODE = 'recipient_suppressed'

/**
 * Error code: the suppression was lifted already.
 */
export const ALREADY_LIFTED_CODE = 'already_lifted'

const EMAIL_NOT_FOUND = 'Email not found'
const SUPPRESSION_NOT_FOUND = 'Suppression not found'
const DAY_MS = 24 * 60 * 60 * 1000
const BREAKDOWN_LIMIT = 10
const GROUP_NAMES = Object.keys(EMAIL_MESSAGE_GROUPS) as EmailMessageGroup[]

/**
 * The group each status counts in; `queued` counts in none.
 */
const GROUP_OF_STATUS: ReadonlyMap<EmailMessageStatus, EmailMessageGroup> = new Map(
  GROUP_NAMES.flatMap((group) =>
    EMAIL_MESSAGE_GROUPS[group].map((status): [EmailMessageStatus, EmailMessageGroup] => [
      status,
      group,
    ])
  )
)

/**
 * Whether a stored template key names a template this build can render.
 * @param key - The stored `template_key`.
 * @returns True for one of EMAIL_TEMPLATE_KEYS.
 */
export function isKnownTemplateKey(key: string): key is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(key)
}

/**
 * The resend action a stored template has, or null when it has none or is unknown.
 * @param key - The stored `template_key`.
 * @returns The action, or null.
 */
function resendActionOf(key: string): ResendAction | null {
  // eslint-disable-next-line unicorn/no-null -- an unknown template has no action
  return isKnownTemplateKey(key) ? EMAIL_TEMPLATE_META[key].resendAction : null
}

/**
 * A person's display name: their first and last name, or their address when they have neither.
 * @param user - The joined user.
 * @returns The reference the API returns, or null when there is no user.
 */
function personOf(user: EmailUserRow | null): EmailPerson | null {
  // eslint-disable-next-line unicorn/no-null -- JSON null: no user, or purged
  if (user === null) return null
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return { id: user.id, name: name === '' ? user.email : name }
}

/**
 * Encode a cursor for the wire.
 * @param cursor - The decoded cursor, if any.
 * @returns The opaque string, or null at that end of the list.
 */
function encodeEmailCursor(cursor: EmailPageCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at each end of the list
  return cursor ? encodeCursor({ sortAt: cursor.sortAt, id: cursor.id }) : null
}

/**
 * What `canResendFor` needs besides the message, read once for a whole page.
 */
export interface ResendContext {
  /**
   * The requesting staff member's platform role, or null when no longer staff.
   */
  actorPlatformRole: MembershipRole | null
  /**
   * Platform roles of the messages' users; a non-staff user is absent.
   */
  targetPlatformRoles: ReadonlyMap<string, MembershipRole>
  /**
   * The actor's membership roles in the messages' tenants; absent where they are not a member.
   */
  actorMembershipRoles: ReadonlyMap<string, MembershipRole>
  /**
   * The messages' invitations that still exist.
   */
  invitations: ReadonlyMap<string, ResendInvitationRow>
  /**
   * Lowercased recipient addresses with an active suppression.
   */
  suppressedAddresses: ReadonlySet<string>
}

/**
 * Whether the requesting staff member could resend `message` now: a hint
 * for the UI, computed with the same predicates the delegated actions
 * enforce, which the resend endpoint still runs. True only when the actor
 * is a platform admin or owner, the template has a resend action, the row
 * carries the ids that action needs, the recipient is not suppressed, and
 * the user (for user-targeted mail) is active and, for verification, not
 * yet verified, and the action's own actor check passes: `canStaffMailTarget` against the
 * user's platform role for verification and password mail, and
 * `canActorGrantRole` on the invitation's role for an invitation, with the
 * actor's role in that tenant (membership first, as `lockTenantAccess`
 * resolves it, else the platform role).
 * @param actor - The requesting staff member.
 * @param message - The message.
 * @param context - The page's batched lookups (`loadResendContext`).
 * @returns Whether a resend would pass those checks.
 */
export function canResendFor(
  actor: Actor,
  message: PlatformEmailRecord,
  context: ResendContext
): boolean {
  const actorRole = context.actorPlatformRole
  if (actorRole === null || !isRoleAtLeast(actorRole, 'admin')) return false
  const action = resendActionOf(message.templateKey)
  if (action === null || context.suppressedAddresses.has(message.recipient.toLowerCase())) {
    return false
  }
  if (action === 'invitation') {
    if (message.tenantId === null || message.invitationId === null) return false
    const invitation = context.invitations.get(message.invitationId)
    if (invitation?.tenantId !== message.tenantId) return false
    const tenantRole = context.actorMembershipRoles.get(message.tenantId) ?? actorRole
    return canActorGrantRole(tenantRole, invitation.role)
  }
  if (message.userId === null || message.user === null || message.user.deletedAt !== null) {
    return false
  }
  // A deactivated user, or a verification resend to a verified one, is a certain 409
  if (!message.user.isActive) return false
  if (action === 'verification' && message.user.isVerified) return false
  // eslint-disable-next-line unicorn/no-null -- a non-staff user has no platform role
  return canStaffMailTarget(actorRole, context.targetPlatformRoles.get(message.userId) ?? null)
}

/**
 * Read everything `canResendFor` needs for a set of messages in five queries.
 * @param actor - The requesting staff member.
 * @param messages - The messages.
 * @returns The context.
 */
export async function loadResendContext(
  actor: Actor,
  messages: readonly PlatformEmailRecord[]
): Promise<ResendContext> {
  const userIds = [...new Set(messages.flatMap((message) => message.userId ?? []))]
  const tenantIds = [...new Set(messages.flatMap((message) => message.tenantId ?? []))]
  const invitationIds = [...new Set(messages.flatMap((message) => message.invitationId ?? []))]
  const [actorPlatformRole, targetPlatformRoles, actorMembershipRoles, invitations, suppressed] =
    await Promise.all([
      getPlatformMembership(actor.userId),
      platformEmailRepository.platformRolesOf(userIds),
      platformEmailRepository.membershipRolesIn(actor.userId, tenantIds),
      platformEmailRepository.invitationsById(invitationIds),
      platformEmailRepository.activeSuppressionsFor(messages.map((message) => message.recipient)),
    ])
  return {
    actorPlatformRole,
    targetPlatformRoles,
    actorMembershipRoles,
    invitations,
    suppressedAddresses: new Set(suppressed.keys()),
  }
}

/**
 * A record as the staff list returns it.
 * @param message - The record.
 * @param isResendable - `canResendFor`'s answer.
 * @returns The summary.
 */
function toSummary(message: PlatformEmailRecord, isResendable: boolean): EmailMessageSummary {
  return {
    id: message.id,
    recipient: message.recipient,
    templateKey: message.templateKey,
    status: message.status,
    senderClass: message.senderClass,
    createdAt: message.createdAt,
    statusUpdatedAt: message.statusUpdatedAt,
    user: personOf(message.user),
    tenant: message.tenant,
    canResend: isResendable,
  }
}

/**
 * Search messages, newest first, one keyset page at a time in either direction.
 * @param actor - The requesting staff member, for `canResend`.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page and both cursors.
 */
export async function searchEmails(
  actor: Actor,
  query: PlatformEmailSearchQuery
): Promise<EmailMessagePage> {
  const page = await platformEmailRepository.search({
    limit: query.limit,
    direction: query.direction,
    q: query.q,
    status: query.status,
    templateKey: query.template,
    tenantId: query.tenantId,
    userId: query.userId,
    createdFrom: query.from === undefined ? undefined : new Date(`${query.from}T00:00:00.000Z`),
    createdBefore:
      query.to === undefined
        ? undefined
        : new Date(Date.parse(`${query.to}T00:00:00.000Z`) + DAY_MS),
    cursor: query.cursor,
  })
  const context = await loadResendContext(actor, page.rows)
  return {
    messages: page.rows.map((message) => toSummary(message, canResendFor(actor, message, context))),
    nextCursor: encodeEmailCursor(page.nextCursor),
    prevCursor: encodeEmailCursor(page.prevCursor),
  }
}

/**
 * The message or a 404.
 * @param id - The message id.
 * @returns The record.
 * @throws {HttpError} 404 when no message has that id.
 */
async function requireMessage(id: string): Promise<PlatformEmailRecord> {
  const message = await platformEmailRepository.findRecord(id)
  if (!message) throw new HttpError(EMAIL_NOT_FOUND, 404)
  return message
}

/**
 * One message with its attempts, provider events, the recipient's active
 * suppression, and the resend chain either side of it.
 * @param actor - The requesting staff member, for `canResend`.
 * @param id - The message id.
 * @returns The detail.
 * @throws {HttpError} 404 when no message has that id.
 */
export async function getEmailDetail(actor: Actor, id: string): Promise<EmailMessageDetail> {
  const message = await requireMessage(id)
  const [context, attempts, events, suppressions, resentAsIds] = await Promise.all([
    loadResendContext(actor, [message]),
    platformEmailRepository.listAttempts(id),
    platformEmailRepository.listEvents(id),
    platformEmailRepository.activeSuppressionsFor([message.recipient]),
    platformEmailRepository.listResentAsIds(id),
  ])
  const suppression = suppressions.get(message.recipient.toLowerCase())
  return {
    ...toSummary(message, canResendFor(actor, message, context)),
    linkApp: message.linkApp,
    failureOrigin: message.failureOrigin,
    attempts,
    events,
    suppression: suppression
      ? { id: suppression.id, reason: suppression.reason, createdAt: suppression.createdAt }
      : // eslint-disable-next-line unicorn/no-null -- JSON null: the address is not suppressed
        null,
    resentFromId: message.resentFromId,
    resentAsIds,
  }
}

/**
 * The link a preview shows: the real page on the real frontend, its token masked.
 * @param build - The URL builder the real mail uses.
 * @param origin - The frontend origin the real link pointed at.
 * @returns The masked URL.
 */
function maskedLink(build: (rawToken: string, webUrl: string) => string, origin: string): string {
  return `${build('', origin)}${TOKEN_MASK}`
}

/**
 * The mail a preview renders, and whether a stored preview variable was
 * missing (a legacy row, or one written with empty variables) and read as
 * the mask. The masked token and the inviter's fixed placeholder are in
 * every such preview, so they do not make it partial. Only the template's
 * `previewVariables` are read from `stored`, and only string values; every
 * secret is a placeholder, whatever `stored` holds.
 * @param templateKey - The stored template key, already known to the registry.
 * @param stored - The stored variables.
 * @param origin - The frontend origin the real link pointed at.
 * @returns The message to render and the partial flag.
 */
export function buildPreviewMessage(
  templateKey: EmailTemplateKey,
  stored: Readonly<Record<string, unknown>>,
  origin: string
): { message: MailMessage; isPartial: boolean } {
  const allowed: readonly string[] = EMAIL_TEMPLATE_META[templateKey].previewVariables
  let isPartial = false
  const fill = (name: string): string => {
    const value = allowed.includes(name) ? stored[name] : undefined
    if (typeof value === 'string') return value
    isPartial = true
    return TOKEN_MASK
  }
  const to = TOKEN_MASK
  const message = ((): MailMessage => {
    switch (templateKey) {
      case 'email_verification': {
        return {
          to,
          templateKey,
          variables: {
            firstName: fill('firstName'),
            verificationUrl: maskedLink(buildVerificationUrl, origin),
            appName: fill('appName'),
          },
        }
      }
      case 'password_reset': {
        return {
          to,
          templateKey,
          variables: {
            firstName: fill('firstName'),
            resetUrl: maskedLink(buildPasswordResetUrl, origin),
            appName: fill('appName'),
          },
        }
      }
      case 'account_setup': {
        return {
          to,
          templateKey,
          variables: {
            firstName: fill('firstName'),
            setupUrl: maskedLink(buildPasswordResetUrl, origin),
            appName: fill('appName'),
          },
        }
      }
      case 'tenant_invitation': {
        return {
          to,
          templateKey,
          variables: {
            tenantName: fill('tenantName'),
            // Never stored: another person's name that a purge of the inviter could not find.
            inviterName: INVITER_NAME_PLACEHOLDER,
            role: fill('role'),
            acceptUrl: maskedLink(buildInvitationAcceptUrl, origin),
            expiresInDays: fill('expiresInDays'),
            appName: fill('appName'),
          },
        }
      }
      case 'password_changed':
      case 'registration_attempt': {
        return {
          to,
          templateKey,
          variables: { firstName: fill('firstName'), appName: fill('appName') },
        }
      }
    }
  })()
  return { message, isPartial }
}

/**
 * Re-render a message's stored template with its stored variables and
 * placeholders: links keep their real page and frontend with the token
 * masked, the inviter reads `A teammate`, and any other missing variable
 * reads `TOKEN_MASK`. Nothing is sent or stored.
 * @param id - The message id.
 * @returns The subject, HTML, text and whether a stored preview variable was missing.
 * @throws {HttpError} 404 when no message has that id; 409 `template_unavailable` when its template is not in the registry.
 */
export async function previewEmail(id: string): Promise<EmailPreview> {
  const message = await requireMessage(id)
  if (!isKnownTemplateKey(message.templateKey)) {
    throw new HttpError(
      'This email template is no longer available',
      409,
      TEMPLATE_UNAVAILABLE_CODE
    )
  }
  const stored = (await platformEmailRepository.findVariables(id)) ?? {}
  const origin = frontendUrl(message.linkApp ?? 'web')
  const { message: mail, isPartial } = buildPreviewMessage(message.templateKey, stored, origin)
  const rendered = renderForMessage(mail)
  return { subject: rendered.subject, html: rendered.html, text: rendered.text, partial: isPartial }
}

/**
 * A rate and its counts.
 * @param numerator - What is counted.
 * @param denominator - What it is counted out of.
 * @param isKnowable - False for a provider-dependent rate with no provider events.
 * @returns The rate; `value` is null when unknowable or when the denominator is 0.
 */
export function rateOf(numerator: number, denominator: number, isKnowable: boolean): EmailRate {
  return {
    // eslint-disable-next-line unicorn/no-null -- JSON null: shown as "—", not 0%
    value: isKnowable && denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
  }
}

/**
 * Zeroed counts for every group.
 * @returns The counts.
 */
function emptyGroups(): EmailGroupCounts {
  return { delivered: 0, sent: 0, undelivered: 0, complained: 0, suppressed: 0 }
}

/**
 * Deliverability over a range of UTC days, by the day each message was
 * created. `undeliveredRate` needs no webhook (send failures count on
 * their own); every other rate is null while no provider event was
 * received in the range. Open and click rates count `general`-sender
 * messages only.
 * @param range - The window.
 * @param now - The current instant; injectable for tests.
 * @returns The health report.
 */
export async function getEmailHealth(
  range: StatsRange,
  now: Date = new Date()
): Promise<EmailHealth> {
  const { from, to, days } = utcDays(range, now)
  const [statusRows, providerEvents, engagement, byTemplate, byDomain] = await Promise.all([
    platformEmailRepository.statusCountsByDay(from, to),
    platformEmailRepository.providerEventCount(from, to),
    platformEmailRepository.engagement(from, to),
    platformEmailRepository.breakdown('template', from, to, BREAKDOWN_LIMIT),
    platformEmailRepository.breakdown('domain', from, to, BREAKDOWN_LIMIT),
  ])
  const byDay = new Map(days.map((date) => [date, emptyGroups()]))
  const totals = emptyGroups()
  let bounced = 0
  for (const row of statusRows) {
    const group = GROUP_OF_STATUS.get(row.status)
    if (row.status === 'bounced') bounced += row.count
    if (group === undefined) continue
    totals[group] += row.count
    const day = byDay.get(row.day)
    if (day) day[group] += row.count
  }
  const leftServer = totals.sent + totals.delivered + totals.undelivered + totals.complained
  const hasProviderEvents = providerEvents > 0
  return {
    range,
    totals: { ...totals, messages: leftServer, providerEvents },
    rates: {
      undeliveredRate: rateOf(totals.undelivered, leftServer, true),
      deliveredRate: rateOf(totals.delivered, leftServer, hasProviderEvents),
      bounceRate: rateOf(bounced, leftServer, hasProviderEvents),
      complaintRate: rateOf(totals.complained, leftServer, hasProviderEvents),
      openRate: rateOf(engagement.opened, engagement.sent, hasProviderEvents),
      clickRate: rateOf(engagement.clicked, engagement.sent, hasProviderEvents),
    },
    days: days.map((date) => ({ date, ...(byDay.get(date) ?? emptyGroups()) })),
    byTemplate,
    byDomain,
  }
}

/**
 * A suppression record as the API returns it.
 * @param suppression - The record.
 * @returns The view.
 */
function toSuppressionView(suppression: PlatformSuppressionRecord): EmailSuppressionView {
  return {
    id: suppression.id,
    address: suppression.address,
    reason: suppression.reason,
    sourceMessageId: suppression.sourceMessageId,
    createdAt: suppression.createdAt,
    liftedAt: suppression.liftedAt,
    liftedBy: personOf(suppression.liftedBy),
    liftReason: suppression.liftReason,
  }
}

/**
 * Search suppressions, newest first: active ones unless asked otherwise.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page and both cursors.
 */
export async function searchSuppressions(
  query: PlatformSuppressionSearchQuery
): Promise<EmailSuppressionPage> {
  const page = await platformEmailRepository.searchSuppressions({
    limit: query.limit,
    direction: query.direction,
    state: query.state,
    q: query.q,
    cursor: query.cursor,
  })
  return {
    suppressions: page.rows.map((row) => toSuppressionView(row)),
    nextCursor: encodeEmailCursor(page.nextCursor),
    prevCursor: encodeEmailCursor(page.prevCursor),
  }
}

/**
 * Which user or invitation a resend acts on, or a 409 when the row lacks it.
 * @param action - The template's resend action.
 * @param message - The message.
 * @returns The target ids.
 * @throws {HttpError} 409 `not_resendable` when a needed id is missing (a row backfilled from before tracking, or a purged link).
 */
function resendTargetOf(
  action: ResendAction,
  message: PlatformEmailRecord
):
  | { action: 'verification' | 'password_setup'; userId: string }
  | { action: 'invitation'; tenantId: string; invitationId: string } {
  if (action === 'invitation') {
    if (message.tenantId !== null && message.invitationId !== null) {
      return { action, tenantId: message.tenantId, invitationId: message.invitationId }
    }
  } else if (message.userId !== null) {
    return { action, userId: message.userId }
  }
  throw new HttpError('This email cannot be resent', 409, NOT_RESENDABLE_CODE)
}

/**
 * Resend a token email by running the action that sent it, which issues a
 * fresh token: resend-verification or password-setup for the user, or the
 * invitation resend for the invitation. Password-setup sends `account_setup`
 * or `password_reset` by the user's state now, which may differ from the
 * original. The delegated action's gates, errors and audit entry apply
 * unchanged; this adds an `email.resent` entry with the reason once it
 * succeeds. That entry is written after, and separately from, the delegated
 * action's commit: if it fails the call answers 500 though the mail was
 * queued, and a retry rotates the token again. Checks, in order: the message exists; its template is in the
 * registry; it has a resend action and the ids it needs; the recipient is
 * not suppressed; for an invitation, its tenant is active (the member
 * route's `resolveTenant` gate) and, on the platform tenant, the caller
 * signed in within the step-up window.
 * @param actor - The signed-in staff admin.
 * @param id - The message id.
 * @param reason - Why, for the audit log.
 * @param authTime - The access token's `auth_time` (`request.authTime`).
 * @param now - The current time in ms; injectable for tests.
 * @returns `emailSent` when the delegated action reports it; empty for an invitation, whose mail is queued without waiting.
 * @throws {HttpError} 404 unknown message, or an invitation's tenant not active; 409 `template_unavailable`, `not_resendable` or `recipient_suppressed`; 401 `REAUTH_REQUIRED` for a platform-tenant invitation with a stale sign-in; and whatever the delegated action throws.
 */
export async function resendEmail(
  actor: Actor,
  id: string,
  reason: string,
  authTime: number | undefined,
  now: number = Date.now()
): Promise<Partial<EmailDelivery>> {
  const message = await requireMessage(id)
  if (!isKnownTemplateKey(message.templateKey)) {
    throw new HttpError(
      'This email template is no longer available',
      409,
      TEMPLATE_UNAVAILABLE_CODE
    )
  }
  // Captured once narrowed: the audit entry is written in a callback, where a property's narrowing does not reach.
  const templateKey = message.templateKey
  const action = EMAIL_TEMPLATE_META[templateKey].resendAction
  if (action === null) {
    throw new HttpError('Security notices are never resent', 409, NOT_RESENDABLE_CODE)
  }
  const target = resendTargetOf(action, message)
  if (await emailSuppressionRepository.findActive(message.recipient)) {
    throw new HttpError(
      'This address is suppressed; lift the suppression first',
      409,
      RECIPIENT_SUPPRESSED_CODE
    )
  }
  const options = { resentFromId: message.id }

  let delivery: Partial<EmailDelivery> = {}
  switch (target.action) {
    case 'verification': {
      delivery = await resendUserVerification(actor, target.userId, options)
      break
    }
    case 'password_setup': {
      delivery = await sendPasswordSetup(actor, target.userId, options)
      break
    }
    case 'invitation': {
      const tenant = await platformEmailRepository.tenantState(target.tenantId)
      if (tenant?.lifecycleState !== 'active') throw new HttpError('Tenant not found', 404)
      if (tenant.isPlatform && !isRecentAuth(authTime, now)) {
        throw new HttpError('Confirm your identity to continue', 401, REAUTH_REQUIRED_CODE)
      }
      await resendInvitation(actor, target.tenantId, target.invitationId, options)
      break
    }
  }

  // No role re-check here: the delegate enforced it and queued the mail, so the reason is recorded whatever happens to the role now.
  await withTransaction(async (tx) => {
    const platform = await platformTenantOrThrow(tx)
    await record(
      {
        action: 'email.resent',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: message.id,
        metadata: {
          reason,
          // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
          emailDomain: hostnameDomain(message.recipient) ?? null,
          templateKey,
        },
      },
      tx
    )
  })
  return delivery
}

/**
 * Lift an active suppression, so sends to the address go out again. One
 * conditional UPDATE decides a race between two lifts; the loser gets 409.
 * The actor's platform role is re-read under lock first, as every staff write does.
 * @param actor - The signed-in staff admin.
 * @param id - The suppression id.
 * @param reason - Why, stored on the row and in the audit entry.
 * @returns The lifted suppression.
 * @throws {HttpError} 404 unknown suppression; 409 `already_lifted`.
 */
export async function liftSuppression(
  actor: Actor,
  id: string,
  reason: string
): Promise<EmailSuppressionView> {
  await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const lifted = await emailSuppressionRepository.lift(
      id,
      { liftedBy: actor.userId, liftReason: reason },
      tx
    )
    if (!lifted) {
      const existing = await platformEmailRepository.findSuppression(id, tx)
      if (!existing) throw new HttpError(SUPPRESSION_NOT_FOUND, 404)
      throw new HttpError('This suppression was lifted already', 409, ALREADY_LIFTED_CODE)
    }
    const platform = await platformTenantOrThrow(tx)
    await record(
      {
        action: 'email.suppression_lifted',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: lifted.id,
        metadata: {
          reason,
          // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
          emailDomain: hostnameDomain(lifted.address) ?? null,
        },
      },
      tx
    )
  })
  const view = await platformEmailRepository.findSuppression(id)
  if (!view) throw new HttpError(SUPPRESSION_NOT_FOUND, 404)
  return toSuppressionView(view)
}
