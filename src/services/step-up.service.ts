/**
 * @file Step-up for staff ("Confirm it's you"): a signed-in staff member
 * proves their identity again, which moves their session's
 * `authenticated_at` to now, for the routes behind `requireRecentAuth`.
 * The one way in is an emailed link (`requestStepUpLink`,
 * `confirmStepUpLink`), bound to the user and the session that asked, so
 * another session, even the same user's, neither matches nor spends it.
 * Google is not offered: Google documents no account re-authentication, so
 * a Google round-trip cannot prove the person is present.
 */
import { getEnv } from '@/configs/env.config'
import {
  ACCESS_TOKEN_EXPIRED_CODE,
  LINK_INVALID_CODE,
  LINK_INVALID_MESSAGE,
} from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record, type AuditEntry } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import {
  buildStepUpConfirmUrl,
  claimLinkToken,
  issueLinkToken,
} from '@/services/link-token.service'
import { logger } from '@/services/logger.service'
import { claimCooldown, releaseCooldown } from '@/services/mail-cooldown.service'
import { getPlatformMembership } from '@/services/platform.service'
import { markSessionReauthenticated, signAccessToken } from '@/services/session.service'
import { STEP_UP_LINK_TEMPLATE_KEY } from '@/templates/email/step-up-link.template'
import { formatWait, requireDurationMs } from '@/utilities/duration.utilities'

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()

/**
 * The cooldown key segment: at most one step-up link per user per
 * `STEP_UP_LINK_COOLDOWN`.
 */
const STEP_UP_LINK_COOLDOWN_SCOPE = 'step-up-link'

/**
 * Machine-readable code for a step-up link asked for inside the cooldown,
 * answered 429 with `Retry-After`.
 */
const STEP_UP_LINK_COOLDOWN_CODE = 'STEP_UP_LINK_COOLDOWN'

const MS_PER_SECOND = 1000

/**
 * A step-up asked for on a token with no session, or by an account gone or
 * inactive: the client refreshes, and that refresh fails and signs it out.
 * @returns A 401 `ACCESS_TOKEN_EXPIRED`.
 */
function sessionEnded(): HttpError {
  return new HttpError('Session ended', 401, ACCESS_TOKEN_EXPIRED_CODE)
}

/**
 * The caller's account, when it still exists and is active.
 * @param userId - The authenticated caller.
 * @returns The account.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for an account gone or inactive.
 */
async function activeAccount(userId: string): Promise<User> {
  const user = await userRepository.findById(userId)
  if (!user?.active) throw sessionEnded()
  return user
}

/**
 * One step-up outcome's action and metadata: a confirmation by link, or a
 * link confirm refused because the caller is no longer staff.
 */
type StepUpOutcome = {
  [TAction in 'auth.step_up_confirmed' | 'auth.step_up_refused']: Pick<
    Extract<AuditEntry, { action: TAction }>,
    'action' | 'metadata'
  >
}['auth.step_up_confirmed' | 'auth.step_up_refused']

/**
 * Audit one step-up outcome in the platform tenant: step-up admits staff
 * only, so the actor is a member there.
 * @param userId - The staff member, actor and target both.
 * @param outcome - The action and its metadata.
 * @param tx - The transaction to write in.
 * @throws {HttpError} 500 when the platform tenant is missing.
 */
async function recordStepUp(
  userId: string,
  outcome: StepUpOutcome,
  tx: DbTransaction
): Promise<void> {
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)
  await record(
    { ...outcome, actor: { userId }, access: 'member', tenantId: platform.id, targetId: userId },
    tx
  )
}

/**
 * Mail a step-up link for the calling session: `<apex>/auth/confirm?token=…`,
 * valid for `STEP_UP_LINK_TTL`, at most one per user per
 * `STEP_UP_LINK_COOLDOWN`. Issuing revokes the session's earlier live link.
 * A failure to issue or queue the mail gives the cooldown back, so the
 * caller can ask again at once.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @returns When the next request may mail again.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid` or an account gone or inactive; 429 `STEP_UP_LINK_COOLDOWN` with `retryAfterSeconds` inside the cooldown.
 */
export async function requestStepUpLink(
  userId: string,
  sessionId: string | undefined
): Promise<{ resendAvailableAt: string }> {
  if (sessionId === undefined) throw sessionEnded()
  const user = await activeAccount(userId)
  const env = getEnv()
  const cooldownMs = requireDurationMs(env.STEP_UP_LINK_COOLDOWN)
  const claim = await claimCooldown(STEP_UP_LINK_COOLDOWN_SCOPE, userId, cooldownMs)
  if (!claim.claimed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(claim.retryAfterMs / MS_PER_SECOND))
    throw new HttpError(
      `Check your inbox for the link we sent. You can ask for another in ${formatWait(retryAfterSeconds)}.`,
      429,
      STEP_UP_LINK_COOLDOWN_CODE,
      undefined,
      { retryAfterSeconds }
    )
  }
  const claimedAt = Date.now()
  try {
    const ttlMs = requireDurationMs(env.STEP_UP_LINK_TTL)
    const { raw } = await issueLinkToken(
      { intent: 'step_up', userId, sessionId, email: user.email, app: 'apex' },
      ttlMs
    )
    await addEmailJob(
      {
        to: user.email.toLowerCase(),
        templateKey: STEP_UP_LINK_TEMPLATE_KEY,
        variables: {
          firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
          confirmUrl: buildStepUpConfirmUrl(raw),
          expiresInMinutes: String(Math.round(ttlMs / 60_000)),
          appName: appNameFor('apex'),
        },
      },
      userId,
      { context: { linkApp: 'apex' } }
    )
  } catch (error) {
    await releaseCooldown(STEP_UP_LINK_COOLDOWN_SCOPE, userId)
    throw error
  }
  return { resendAvailableAt: new Date(claimedAt + cooldownMs).toISOString() }
}

/**
 * A link step-up refused because the caller is no longer staff: thrown
 * inside the confirm's transaction so the claim rolls back and the link
 * stays unspent.
 */
class LinkStepUpRefused extends Error {
  constructor() {
    super('Link step-up refused: not_staff')
    this.name = 'LinkStepUpRefused'
  }
}

/**
 * Confirm a step-up link for the calling session, in one transaction: lock
 * the user row, spend the link, re-check that the caller is still staff,
 * move the session's `authenticated_at` to now and audit
 * `auth.step_up_confirmed`; then sign a new access token carrying the time.
 * The refresh token is untouched: the session is the same.
 *
 * The claim matches only the user and session the link was issued for, so
 * a link presented by another session, the same user's included, answers
 * `LINK_INVALID` and stays live for its own session. Every dead link (used,
 * expired, revoked with its session, unknown) answers the same 400, never a
 * 401: the clients sign out on a 401; such a refusal writes no audit entry,
 * since it is not attributable beyond the bearer and the limiter bounds it.
 * Because the claim shares the transaction, a confirm that fails after it
 * (the caller no longer staff, the session ended, a database fault) rolls
 * the claim back and leaves the link usable. A caller who lost the platform
 * role since the route's gate is refused with the gate's own 404, audited
 * `auth.step_up_refused` in a transaction of its own.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @param raw - The raw token from the link.
 * @returns A new access token for the same session.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid`, an account gone or inactive, or a session that has ended; 400 `LINK_INVALID` for a link this session cannot use; 404 for a caller no longer staff.
 */
export async function confirmStepUpLink(
  userId: string,
  sessionId: string | undefined,
  raw: string
): Promise<{ accessToken: string }> {
  if (sessionId === undefined) throw sessionEnded()
  const user = await activeAccount(userId)
  try {
    const outcome = await withTransaction(async (tx): Promise<Date | 'link_invalid'> => {
      // The user row first, as every step-up takes it (ARCHITECTURE.md, lock order), then the link row the claim writes.
      await userRepository.lockById(userId, 'no key update', tx)
      const claimed = await claimLinkToken(raw, 'step_up', { userId, sessionId }, tx)
      // Commits: a dead link stays spent, so one presentation is one attempt.
      if (!claimed) return 'link_invalid'
      if ((await getPlatformMembership(userId, tx)) === null) throw new LinkStepUpRefused()
      const at = await markSessionReauthenticated(userId, sessionId, tx)
      await recordStepUp(
        userId,
        { action: 'auth.step_up_confirmed', metadata: { method: 'link' } },
        tx
      )
      return at
    })
    if (outcome === 'link_invalid') {
      throw new HttpError(LINK_INVALID_MESSAGE, 400, LINK_INVALID_CODE)
    }
    return { accessToken: signAccessToken(user, sessionId, outcome) }
  } catch (error) {
    if (!(error instanceof LinkStepUpRefused)) throw error
    logger.warn('Link step-up refused (step_up_refused)', { reason: 'not_staff', userId })
    await recordRefusal(userId)
    // The answer a caller without a platform role gets on every staff route.
    throw new HttpError('Not found', 404)
  }
}

/**
 * Audit a refused step-up in a transaction of its own, since the refusal
 * writes nothing else. Never rejects: a failed write (an account since
 * deleted, say) is logged, and the refusal stands either way.
 * @param userId - The staff member the refusal is about.
 */
async function recordRefusal(userId: string): Promise<void> {
  try {
    await withTransaction((tx) =>
      recordStepUp(userId, { action: 'auth.step_up_refused', metadata: { method: 'link' } }, tx)
    )
  } catch (error) {
    logger.error('Recording a refused step-up failed', { error: redactedForLog(error) })
  }
}
