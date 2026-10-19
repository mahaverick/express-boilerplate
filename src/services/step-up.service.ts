/**
 * @file Step-up for staff ("Confirm it's you"): a signed-in staff member
 * proves their identity again, which moves their session's
 * `authenticated_at` to now, for the routes behind `requireRecentAuth`.
 * Two ways in. An emailed link (`requestStepUpLink`, `confirmStepUpLink`)
 * is bound to the user and the session that asked, so another session,
 * even the same user's, neither matches nor spends it. A fresh Google login
 * (`startGoogleStepUp`, `confirmGoogleStepUp`) is accepted only for the
 * Google identity linked to the account, with an ID token whose
 * `auth_time` is no older than the start; it mints no session.
 */
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { getEnv } from '@/configs/env.config'
import { OAUTH_SESSION_MAX_AGE_MS } from '@/configs/passport.config'
import {
  ACCESS_TOKEN_EXPIRED_CODE,
  LINK_INVALID_CODE,
  LINK_INVALID_MESSAGE,
} from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record, type AuditEntry } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
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
import type { OAuthIntent } from '@/types/oauth-intent'
import { formatWait, requireDurationMs } from '@/utilities/duration.utilities'
import { decodeIdTokenClaims, type IdTokenClaims } from '@/utilities/id-token.utilities'

const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()
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

/**
 * Machine-readable code for a Google step-up start on an account with no
 * Google identity linked.
 */
const GOOGLE_NOT_LINKED_CODE = 'google_not_linked'

/**
 * The issuers Google's ID tokens carry: Google documents both forms.
 */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
])

/**
 * How far Google's `auth_time` may sit before the start, in seconds: clock
 * skew between Google and this server, not a grace period for an older
 * login.
 */
const AUTH_TIME_SKEW_SECONDS = 60

const MS_PER_SECOND = 1000

/**
 * A step-up intent, as the OAuth session holds it between the start and the
 * callback.
 */
export type StepUpIntent = Extract<OAuthIntent, { kind: 'step_up' }>

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
 * One step-up outcome's action and metadata: a confirmation by link or
 * Google, or a refused Google confirm.
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
          appName: env.APP_NAME,
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
    await recordRefusal(userId, 'link')
    // The answer a caller without a platform role gets on every staff route.
    throw new HttpError('Not found', 404)
  }
}

/**
 * Check that a staff member may start a Google step-up, and build the intent
 * the OAuth session keeps until the callback.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @returns The intent to store, stamped with the start time.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid` or an account gone or inactive; 409 `google_not_linked` for an account with no Google identity.
 */
export async function startGoogleStepUp(
  userId: string,
  sessionId: string | undefined
): Promise<StepUpIntent> {
  if (sessionId === undefined) throw sessionEnded()
  await activeAccount(userId)
  const providers = await authProviderRepository.findByUser(userId)
  if (providers.every((provider) => provider.provider !== 'google')) {
    throw new HttpError(
      'Your account has no linked Google account. Confirm by email instead.',
      409,
      GOOGLE_NOT_LINKED_CODE
    )
  }
  return { kind: 'step_up', userId, sessionId, startedAt: Date.now() }
}

/**
 * Whether a stored step-up intent is still inside the OAuth session's
 * lifetime, so the popup may go on to Google.
 * @param intent - The stored intent.
 * @returns True when it started no longer ago than the OAuth session lasts.
 */
export function isStepUpIntentFresh(intent: StepUpIntent): boolean {
  const age = Date.now() - intent.startedAt
  return age >= 0 && age <= OAUTH_SESSION_MAX_AGE_MS
}

/**
 * Why a Google step-up was refused, for the log line an operator reads.
 */
type GoogleRefusal =
  | 'id_token_missing'
  | 'id_token_malformed'
  | 'issuer'
  | 'audience'
  | 'id_token_expired'
  | 'token_sub_mismatch'
  | 'auth_time_missing'
  | 'auth_time_stale'
  | 'google_not_linked'
  | 'not_staff'
  | 'session_ended'

/**
 * A Google step-up refused for `reason`, before any write.
 */
class GoogleStepUpRefused extends Error {
  /**
   * @param reason - Which check failed.
   */
  constructor(readonly reason: GoogleRefusal) {
    super(`Google step-up refused: ${reason}`)
    this.name = 'GoogleStepUpRefused'
  }
}

/**
 * The ID token checks: from Google, for this client, for the profile's
 * account, and a login no older than the start (less the clock skew).
 * @param intent - The stored intent, for its start time.
 * @param profile - The Google profile the callback received.
 * @param idToken - The raw ID token from the token endpoint, if any.
 * @returns The decoded claims.
 * @throws {GoogleStepUpRefused} Naming the first check that failed.
 */
function checkedClaims(
  intent: StepUpIntent,
  profile: GoogleProfile,
  idToken: string | undefined
): IdTokenClaims {
  if (idToken === undefined || idToken === '') throw new GoogleStepUpRefused('id_token_missing')
  let claims: IdTokenClaims
  try {
    claims = decodeIdTokenClaims(idToken)
  } catch {
    throw new GoogleStepUpRefused('id_token_malformed')
  }
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new GoogleStepUpRefused('issuer')
  // A list is refused too: Google issues one audience, and a list would need an `azp` check this does not make.
  if (typeof claims.aud !== 'string' || claims.aud !== getEnv().GOOGLE_CLIENT_ID) {
    throw new GoogleStepUpRefused('audience')
  }
  if (claims.exp * MS_PER_SECOND <= Date.now()) throw new GoogleStepUpRefused('id_token_expired')
  if (claims.sub !== profile.id) throw new GoogleStepUpRefused('token_sub_mismatch')
  if (claims.auth_time === undefined) throw new GoogleStepUpRefused('auth_time_missing')
  const earliest = Math.floor(intent.startedAt / MS_PER_SECOND) - AUTH_TIME_SKEW_SECONDS
  if (claims.auth_time < earliest) throw new GoogleStepUpRefused('auth_time_stale')
  return claims
}

/**
 * Audit a refused step-up in a transaction of its own, since the refusal
 * writes nothing else. Never rejects: a failed write (an account since
 * deleted, say) is logged, and the refusal stands either way.
 * @param userId - The staff member the refusal is about.
 * @param method - The way in that was refused.
 */
async function recordRefusal(userId: string, method: 'link' | 'google'): Promise<void> {
  try {
    await withTransaction((tx) =>
      recordStepUp(userId, { action: 'auth.step_up_refused', metadata: { method } }, tx)
    )
  } catch (error) {
    logger.error('Recording a refused step-up failed', { error: redactedForLog(error) })
  }
}

/**
 * Confirm a Google step-up from the callback: the ID token checks
 * (`iss`, `aud`, `sub`, `auth_time`), the profile's `sub` equal to the
 * account's linked Google identity (an address match is not enough), and then
 * one transaction that moves the session's `authenticated_at`, re-reads the
 * caller's platform role under the user-row lock, and audits
 * `auth.step_up_confirmed`. Nothing here
 * issues a token or a session.
 *
 * The ID token is decoded without a signature check, which OIDC Core
 * §3.1.3.7 (step 6) allows for a token this server received straight from
 * Google's token endpoint over TLS. Every refusal is audited as
 * `auth.step_up_refused` in its own transaction, logged at warn with the
 * check that failed, and thrown.
 * @param intent - The stored step-up intent: who, which session, and when it started.
 * @param profile - The Google profile the callback received.
 * @param idToken - The raw ID token from the token endpoint; undefined when it sent none.
 * @returns Resolves once the session is marked and the confirmation audited.
 * @throws {HttpError} 400 `step_up_failed` for any refusal.
 */
export async function confirmGoogleStepUp(
  intent: StepUpIntent,
  profile: GoogleProfile,
  idToken: string | undefined
): Promise<void> {
  const { userId, sessionId } = intent
  try {
    checkedClaims(intent, profile, idToken)
    const linked = await authProviderRepository.findByProviderAndId('google', profile.id)
    if (linked?.userId !== userId) throw new GoogleStepUpRefused('google_not_linked')
    await withTransaction(async (tx) => {
      try {
        await markSessionReauthenticated(userId, sessionId, tx)
      } catch (error) {
        if (error instanceof HttpError && error.code === ACCESS_TOKEN_EXPIRED_CODE) {
          throw new GoogleStepUpRefused('session_ended')
        }
        throw error
      }
      // Under the user-row lock the mark took, as the link confirm reads it: a demotion committed meanwhile refuses, and the throw rolls the mark back.
      if ((await getPlatformMembership(userId, tx)) === null) {
        throw new GoogleStepUpRefused('not_staff')
      }
      await recordStepUp(
        userId,
        { action: 'auth.step_up_confirmed', metadata: { method: 'google' } },
        tx
      )
    })
  } catch (error) {
    if (!(error instanceof GoogleStepUpRefused)) throw error
    logger.warn('Google step-up refused (step_up_refused)', { reason: error.reason, userId })
    await recordRefusal(userId, 'google')
    throw new HttpError(
      "We couldn't confirm it's you with Google. Try again, or confirm by email.",
      400,
      'step_up_failed'
    )
  }
}
