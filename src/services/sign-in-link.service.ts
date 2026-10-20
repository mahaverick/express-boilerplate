/**
 * @file Signing in by an emailed link. A request answers one fixed reply for
 * every address and does its work after it (`requestSignInLink`): the
 * cooldown, the daily budget, the lookup and the mail, any of which stops it
 * silently; on Apex a staff invitee is mailed their invitation instead. A
 * verify (`verifySignInLink`) refuses a link displaying another address
 * without spending it, then spends the link once and signs in
 * the account its address holds, creating a verified account on the first
 * click when there is none. Every dead link, and every account it may not
 * sign in, answers one `LINK_INVALID`.
 */
import { randomUUID } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import { LINK_INVALID_CODE, LINK_INVALID_MESSAGE } from '@/constants/auth.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import { READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import { UserRepository } from '@/repositories/user.repository'
import {
  claimNeverVerifiedAccount,
  clearSquatterCredentials,
  createLinkedAccount,
  isAddressTaken,
  isClaimedAccountGone,
} from '@/services/account-claim.service'
import { platformRoleForLogin } from '@/services/auth.service'
import { withTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import {
  buildSignInLinkUrl,
  claimLinkToken,
  issueLinkToken,
  peekLinkToken,
} from '@/services/link-token.service'
import { logger } from '@/services/logger.service'
import { didClaimMailCooldown } from '@/services/mail-cooldown.service'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  assertCreationAllowedByMode,
  assertSignInAllowed,
} from '@/services/maintenance-mode/maintenance-mode.service'
import { getPlatformMembership } from '@/services/platform.service'
import {
  issueRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { spendSignInLinkBudget } from '@/services/sign-in-link-limit.service'
import { mailPlatformInvitationConfirmForSignIn } from '@/services/tenant-invitation.service'
import { SIGN_IN_LINK_TEMPLATE_KEY } from '@/templates/email/sign-in-link.template'
import { WELCOME_TEMPLATE_KEY } from '@/templates/email/welcome.template'
import type { EmailResendOptions } from '@/types/email-context'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { requireDurationMs } from '@/utilities/duration.utilities'
import type { SignInLinkRequestInput } from '@/validators/sign-in-link.validators'

const userRepository = new UserRepository()

/**
 * The cooldown key segment: at most one sign-in link per address per
 * `SIGN_IN_LINK_MAIL_COOLDOWN`.
 */
const MAIL_COOLDOWN_SCOPE = 'sign-in-link'

/**
 * A successful verify: the account, its new session's tokens, its platform
 * role, whether this click created it, and the redirect stored with the
 * link.
 */
export interface LinkSession {
  user: User
  accessToken: string
  refreshToken: IssuedRefreshToken
  platformRole: MembershipRole | null
  isNewUser: boolean
  redirect: string | null
}

/**
 * Who a sign-in link goes to and why. `userId` names the account the
 * address holds, when there is one, so the mail greets it by its stored
 * name and its message row names it. `reason` is `self` when the recipient
 * asked, `staff` when a team admin sent it, `welcome` for a new account a
 * team admin created.
 */
interface SignInLinkTarget {
  email: string
  app: FrontendApp
  redirect?: string
  userId?: string
  reason?: 'self' | 'staff' | 'welcome'
}

/**
 * The one answer for a link that signs nobody in.
 * @returns A 400 `LINK_INVALID`, never a 401: the clients sign out on a 401.
 */
function linkInvalid(): HttpError {
  return new HttpError(LINK_INVALID_MESSAGE, 400, LINK_INVALID_CODE)
}

/**
 * Issue a sign-in link for an address and queue its mail. Issuing revokes
 * the address's earlier live links. Rejects when the link or the job cannot
 * be written; a caller after its reply catches that. The `welcome` reason
 * mails the `welcome` template; `self` and `staff` mail `sign_in_link`, with
 * the staff sentence for `staff`.
 * @param target - The address, the frontend the link opens, a stored redirect, the account and the reason.
 * @param options - `resentFromId` when a staff resend re-runs this flow for an earlier message.
 * @returns Resolves once the mail job is queued.
 */
export async function sendSignInLink(
  target: SignInLinkTarget,
  options: EmailResendOptions = {}
): Promise<void> {
  const ttlMs = requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  const { raw, row } = await issueLinkToken(
    {
      intent: 'sign_in',
      email: target.email,
      app: target.app,
      ...(target.redirect !== undefined && { redirect: target.redirect }),
    },
    ttlMs
  )
  // The stored name, never a submitted one: that would be attacker-chosen text in the inbox.
  const account =
    target.userId === undefined ? undefined : await userRepository.findById(target.userId)
  const to = target.email.toLowerCase()
  const reason = target.reason ?? 'self'
  const variables = {
    firstName: account?.firstName ?? MISSING_FIRST_NAME_FALLBACK,
    signInUrl: buildSignInLinkUrl(
      raw,
      row,
      reason === 'welcome' ? WELCOME_TEMPLATE_KEY : SIGN_IN_LINK_TEMPLATE_KEY
    ),
    expiresInMinutes: String(Math.round(ttlMs / 60_000)),
    expiresAt: formatUtcDateTime(row.expiresAt),
    appName: appNameFor(target.app),
  }
  await addEmailJob(
    reason === 'welcome'
      ? { to, templateKey: WELCOME_TEMPLATE_KEY, variables }
      : { to, templateKey: SIGN_IN_LINK_TEMPLATE_KEY, variables: { ...variables, reason } },
    target.userId ?? '',
    { context: { linkApp: target.app, ...options } }
  )
}

/**
 * What a request's follow-up does for its address: mail a sign-in link, mail
 * a staff invitee their invitation's confirm link, or nothing.
 */
type RequestOutcome =
  | { kind: 'link'; user: User | undefined }
  | { kind: 'invitation'; user: User | undefined }
  | { kind: 'nothing' }

/**
 * Decide what a request's address gets: an inactive account gets nothing; in
 * `full` maintenance only staff get a link and everyone else nothing; on
 * Apex staff get a link and any other address (an invitee is not staff until
 * they accept) gets its pending staff invitation's confirm link, when it
 * holds one; on web everyone else gets a link.
 * @param email - The requested address.
 * @param app - The frontend the link would open.
 * @returns The outcome, with the account the address holds for a link or a confirm link.
 */
async function requestOutcome(email: string, app: FrontendApp): Promise<RequestOutcome> {
  const user = await userRepository.findByEmail(email)
  if (user && !user.active) return { kind: 'nothing' }
  const isFull = getMaintenanceMode().mode === 'full'
  if (app !== 'apex' && !isFull) return { kind: 'link', user }
  const isStaff = user !== undefined && (await getPlatformMembership(user.id)) !== null
  if (isStaff) return { kind: 'link', user }
  // In `full` a non-staff address gets nothing at all, an invitation included.
  return app === 'apex' && !isFull ? { kind: 'invitation', user } : { kind: 'nothing' }
}

/**
 * Accept a sign-in link request. Nothing runs before the reply, so every
 * address gets the same answer at the same cost; the work comes back as a
 * follow-up for the controller to start after replying. In order, it stops
 * silently at the first "nothing": the per-address cooldown
 * (`SIGN_IN_LINK_MAIL_COOLDOWN`, sent when Redis is down), the daily budget
 * (`SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT`), the lookup (an inactive account,
 * or a non-staff or unknown address in `full`, gets nothing), then the mail.
 * An unknown address on web is mailed a link: its click creates the account.
 * On Apex only staff are mailed a link; any other address holding a pending
 * staff invitation is mailed that invitation's confirm link, which joins in
 * one click (`mailPlatformInvitationConfirmForSignIn`, which shares the
 * confirm link's cooldown with a Join click), or nothing when it holds none.
 * @param input - The validated request body.
 * @returns The follow-up; it never rejects, and logs its own failure.
 */
export function requestSignInLink(input: SignInLinkRequestInput): () => Promise<void> {
  return async () => {
    try {
      const cooldownMs = requireDurationMs(getEnv().SIGN_IN_LINK_MAIL_COOLDOWN)
      const canSend = await didClaimMailCooldown(MAIL_COOLDOWN_SCOPE, input.email, cooldownMs, {
        whenUnavailable: 'send',
      })
      // The budget is spent only once the cooldown is won.
      if (!canSend || (await spendSignInLinkBudget(input.email)) === 'exhausted') return
      const outcome = await requestOutcome(input.email, input.app)
      if (outcome.kind === 'invitation') {
        await mailPlatformInvitationConfirmForSignIn(input.email, outcome.user)
        return
      }
      if (outcome.kind === 'nothing') return
      await sendSignInLink({
        email: input.email,
        app: input.app,
        ...(input.redirect !== undefined && { redirect: input.redirect }),
        ...(outcome.user !== undefined && { userId: outcome.user.id }),
        reason: 'self',
      })
    } catch (error) {
      logger.error('Sign-in link mail failed', { error: redactedForLog(error) })
    }
  }
}

/**
 * Refuse, before the link is spent, a verify the maintenance mode would
 * refuse, so the link still works once the mode ends. Reads only: the link
 * is peeked, not claimed. In `full` the account the link's address holds must
 * be staff (`assertSignInAllowed`; a dead link reaches no account and is
 * refused the same way). In `read_only` a web link whose address holds no
 * account would create one, which is a write. In any other mode nothing is
 * read.
 * @param raw - The raw token presented.
 * @throws {MaintenanceModeError} 503 `MAINTENANCE_MODE` in `full` for non-staff, 503 `READ_ONLY_MODE` for an account creation in `read_only`.
 */
async function assertVerifyAllowedByMode(raw: string): Promise<void> {
  const snapshot = getMaintenanceMode()
  if (snapshot.mode !== 'full' && snapshot.mode !== 'read_only') return
  const peeked = await peekLinkToken(raw, 'sign_in')
  const account = peeked?.email ? await userRepository.findByEmail(peeked.email) : undefined
  if (snapshot.mode === 'full') {
    await assertSignInAllowed(account?.id)
    return
  }
  if (!account && peeked?.app === 'web') {
    throw new MaintenanceModeError(READ_ONLY_MODE_CODE, snapshot)
  }
}

/**
 * Refuse a link whose displayed address is not the one it was mailed to.
 * The frontends show "Signing you in as <email>" from the link's `email`
 * param, which anyone can edit: a link carrying one person's token and
 * another's address would sign the visitor in to the first under the
 * second's name. The check runs on a read-only peek, so the refusal spends
 * nothing and the owner's link stays usable. A token's address never
 * changes, so the claim that follows a matching peek spends the same row,
 * and a concurrent click still wins or loses on the claim alone. A dead
 * link falls through to the claim, which answers it as it always has.
 * Neither address is logged.
 * @param raw - The raw token from the link.
 * @param shownEmail - The displayed address, trimmed and lowercased.
 * @returns Resolves when the link is dead or shows its own address.
 * @throws {HttpError} 400 `LINK_INVALID` when a live link shows another address.
 */
async function assertLinkShowsItsAddress(raw: string, shownEmail: string): Promise<void> {
  const peeked = await peekLinkToken(raw, 'sign_in')
  if (!peeked?.email) return
  if (peeked.email.trim().toLowerCase() !== shownEmail) throw linkInvalid()
}

/**
 * Create the account a first click proves, in its own transaction, and emit
 * `email_verified` once it commits. When another write created an account
 * for the address first (a concurrent click, or a registration), the
 * insert loses the users unique index and this answers undefined, so the
 * caller treats that account as an existing one: a link that proved the
 * mailbox is never refused for it, and a never-verified one is claimed.
 * @param email - The link's address.
 * @returns The new account, or undefined when the address was taken meanwhile.
 */
async function createLinkedAccountOnce(email: string): Promise<User | undefined> {
  try {
    const created = await withTransaction((tx) => createLinkedAccount(email, tx))
    await emitDomainEvent({ type: 'email_verified', userId: created.id, at: new Date() })
    return created
  } catch (error) {
    if (!isAddressTaken(error)) throw error
    return undefined
  }
}

/**
 * The account a claimed link signs in, checked for this click: it is
 * created for a web link to an address with none (refused in `read_only`
 * and `full`); an Apex link reaches only an existing staff account; an
 * inactive account is refused; a never-verified one is claimed. An account
 * another write created while this click was creating one goes through the
 * same checks as one that existed before.
 * @param row - The claimed link's address and frontend.
 * @param row.email - The address the link was mailed to.
 * @param row.app - The frontend the link opens.
 * @returns The account and whether this click created it.
 * @throws {HttpError} 400 `LINK_INVALID`, or 503 `READ_ONLY_MODE` or `MAINTENANCE_MODE`.
 */
async function resolveLinkAccount(row: {
  email: string
  app: FrontendApp
}): Promise<{ user: User; isNew: boolean }> {
  let existing = await userRepository.findByEmail(row.email)
  if (!existing) {
    if (row.app === 'apex') throw linkInvalid()
    // The peek before the claim already refused it; this catches a mode that changed since (the link is spent).
    assertCreationAllowedByMode()
    const created = await createLinkedAccountOnce(row.email)
    if (created) return { user: created, isNew: true }
    existing = await userRepository.findByEmail(row.email)
    if (!existing) throw linkInvalid()
  }
  if (!existing.active) throw linkInvalid()
  if (row.app === 'apex' && (await getPlatformMembership(existing.id)) === null) {
    throw linkInvalid()
  }
  if (existing.emailVerifiedAt === null) {
    return { user: await claimForLink(existing.id), isNew: false }
  }
  return { user: existing, isNew: false }
}

/**
 * Claim a never-verified account for a link, with the squatter's credentials
 * cleared. An account deleted or deactivated since the lookup is the generic
 * invalid link, never the claim's 500 or a session.
 * @param userId - The never-verified account.
 * @returns The claimed account, active.
 * @throws {HttpError} 400 `LINK_INVALID` when the account is gone or inactive.
 */
async function claimForLink(userId: string): Promise<User> {
  let claimed: User
  try {
    claimed = await claimNeverVerifiedAccount(userId, clearSquatterCredentials(userId))
  } catch (error) {
    if (isClaimedAccountGone(error)) throw linkInvalid()
    throw error
  }
  if (!claimed.active) throw linkInvalid()
  return claimed
}

/**
 * Sign in by a link: spend it once and sign in the account its address
 * holds. The frontend and the redirect come only from the link's row, never
 * from the request.
 *
 * Order: the maintenance mode is checked on a read-only peek
 * (`assertVerifyAllowedByMode`), so a refused link stays usable; the
 * address the link displays, when the client sends it, is compared with the
 * link's row on another peek (`assertLinkShowsItsAddress`), so a link whose
 * `email` was swapped is `LINK_INVALID` and stays usable for its owner; the
 * link is claimed (any dead link is `LINK_INVALID`); the account is resolved
 * (`resolveLinkAccount`); `assertSignInAllowed` runs on it; `lastLoggedInAt`
 * is stamped outside the lock; then one transaction re-reads the user FOR
 * SHARE and issues the session, so a deactivation or soft delete that
 * committed since is `LINK_INVALID` with no session, and one that commits
 * later waits for the lock and revokes it.
 * @param raw - The raw token from the link.
 * @param shownEmail - The address the link displays, trimmed and lowercased, when the client sends it.
 * @returns The session.
 * @throws {HttpError} 400 `LINK_INVALID`; 503 `MAINTENANCE_MODE` or `READ_ONLY_MODE` (a `MaintenanceModeError`).
 */
export async function verifySignInLink(raw: string, shownEmail?: string): Promise<LinkSession> {
  await assertVerifyAllowedByMode(raw)
  if (shownEmail !== undefined) await assertLinkShowsItsAddress(raw, shownEmail)

  const row = await claimLinkToken(raw, 'sign_in')
  // Every sign_in_link row has both (user_tokens_shape_check); anything else is not a link.
  if (!row?.email || !row.app) throw linkInvalid()

  const { user, isNew } = await resolveLinkAccount({ email: row.email, app: row.app })
  await assertSignInAllowed(user.id)

  // After the checks, so a refused click leaves no trace; before the session, so a failed UPDATE sets no cookie.
  await userRepository.update(user.id, { lastLoggedInAt: new Date() })

  const sessionId = randomUUID()
  const refreshToken = await withTransaction(async (tx) => {
    const locked = await userRepository.lockById(user.id, 'share', tx)
    // Re-checked under the lock: a deactivation or delete that committed since the lookup wins.
    if (!locked?.active) throw linkInvalid()
    return issueRefreshToken(user.id, sessionId, tx)
  })
  const accessToken = signAccessToken(user, sessionId, refreshToken.authenticatedAt)
  const platformRole = await platformRoleForLogin(user.id)
  if (isNew) {
    await emitDomainEvent({
      type: 'user_signed_up',
      userId: user.id,
      method: 'link',
      at: user.createdAt,
    })
  }
  await emitDomainEvent({ type: 'user_signed_in', userId: user.id, method: 'link', at: new Date() })
  return { user, accessToken, refreshToken, platformRole, isNewUser: isNew, redirect: row.redirect }
}
