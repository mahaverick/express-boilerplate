/**
 * @file Step-up ("Confirm it's you"): any signed-in user proves their
 * identity again, which moves their session's `authenticated_at` to now, for
 * the routes behind `requireRecentAuth`. Two ways in. An emailed link
 * (`requestStepUpLink`, `confirmStepUpLink`) is bound to the user and the
 * session that asked, so another session, even the same user's, neither
 * matches nor spends it. A passkey (`startPasskeyStepUp`,
 * `finishPasskeyStepUp`) answers a single-use challenge bound to the same
 * pair, and only one of the caller's own passkeys counts. Google is not
 * offered: Google documents no account re-authentication, so a Google
 * round-trip cannot prove the person is present.
 */
import {
  generateAuthenticationOptions,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'
import { getEnv } from '@/configs/env.config'
import { passkeyRelyingParty } from '@/configs/passkey.config'
import {
  ACCESS_TOKEN_EXPIRED_CODE,
  LINK_INVALID_CODE,
  LINK_INVALID_MESSAGE,
} from '@/constants/auth.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { addEmailJob } from '@/jobs/email.job'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { appNameFor, MISSING_FIRST_NAME_FALLBACK } from '@/services/frontend-links.service'
import {
  buildStepUpConfirmUrl,
  claimLinkToken,
  issueLinkToken,
} from '@/services/link-token.service'
import { claimCooldown, releaseCooldown } from '@/services/mail-cooldown.service'
import {
  consumePasskeyChallenge,
  issuePasskeyChallenge,
} from '@/services/passkey-challenge.service'
import {
  knownTransports,
  passkeyVerificationFailed,
  verifyStoredAssertion,
} from '@/services/passkey.service'
import { markSessionReauthenticated, signAccessToken } from '@/services/session.service'
import { STEP_UP_LINK_TEMPLATE_KEY } from '@/templates/email/step-up-link.template'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { formatWait, requireDurationMs } from '@/utilities/duration.utilities'

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const userPasskeyRepository = new UserPasskeyRepository()

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
 * The code of a passkey step-up asked for by a user with no passkey.
 */
const NO_PASSKEY_CODE = 'NO_PASSKEY'

const MS_PER_SECOND = 1000

/**
 * A step-up asked for on a token with no session, or by an account gone or
 * inactive: the client refreshes, and that refresh fails and signs it out.
 * @returns A 401 `ACCESS_TOKEN_EXPIRED`.
 */
function sessionEnded(): HttpError {
  return new HttpError(
    'This session ended. Sign in again to continue.',
    401,
    ACCESS_TOKEN_EXPIRED_CODE
  )
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
 * Audit a confirmed step-up in the platform tenant, where every step-up row
 * goes. The entry is written with member access, as the passkey audit is.
 * @param userId - The user, actor and target both.
 * @param method - How they confirmed.
 * @param tx - The transaction to write in.
 * @throws {HttpError} 500 when the platform tenant is missing.
 */
async function recordStepUp(
  userId: string,
  method: 'link' | 'passkey',
  tx: DbTransaction
): Promise<void> {
  const platform = await tenantRepository.findPlatformTenant(tx)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)
  await record(
    {
      action: 'auth.step_up_confirmed',
      metadata: { method },
      actor: { userId },
      access: 'member',
      tenantId: platform.id,
      targetId: userId,
    },
    tx
  )
}

/**
 * Mail a step-up link for the calling session: `<frontend>/auth/confirm?token=…`,
 * valid for `STEP_UP_LINK_TTL`, at most one per user per
 * `STEP_UP_LINK_COOLDOWN`. Issuing revokes the session's earlier live link.
 * A failure to issue or queue the mail gives the cooldown back, so the
 * caller can ask again at once.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @param app - The frontend the caller is in; the link opens there.
 * @returns When the next request may mail again.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid` or an account gone or inactive; 429 `STEP_UP_LINK_COOLDOWN` with `retryAfterSeconds` inside the cooldown.
 */
export async function requestStepUpLink(
  userId: string,
  sessionId: string | undefined,
  app: FrontendApp
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
    const { raw, row } = await issueLinkToken(
      { intent: 'step_up', userId, sessionId, email: user.email, app },
      ttlMs
    )
    await addEmailJob(
      {
        to: user.email.toLowerCase(),
        templateKey: STEP_UP_LINK_TEMPLATE_KEY,
        variables: {
          firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
          confirmUrl: buildStepUpConfirmUrl(raw, app),
          expiresInMinutes: String(Math.round(ttlMs / 60_000)),
          expiresAt: formatUtcDateTime(row.expiresAt),
          appName: appNameFor(app),
        },
      },
      userId,
      { context: { linkApp: app } }
    )
  } catch (error) {
    await releaseCooldown(STEP_UP_LINK_COOLDOWN_SCOPE, userId)
    throw error
  }
  return { resendAvailableAt: new Date(claimedAt + cooldownMs).toISOString() }
}

/**
 * Confirm a step-up link for the calling session, in one transaction: lock
 * the user row, spend the link, move the session's `authenticated_at` to now
 * and audit `auth.step_up_confirmed` with `method: 'link'`; then sign a new access token carrying the time.
 * The refresh token is untouched: the session is the same.
 *
 * The claim matches only the user and session the link was issued for, so
 * a link presented by another session, the same user's included, answers
 * `LINK_INVALID` and stays live for its own session. Every dead link (used,
 * expired, revoked with its session, unknown) answers the same 400, never a
 * 401: the clients sign out on a 401; such a refusal writes no audit entry,
 * since it is not attributable beyond the bearer and the limiter bounds it.
 * Because the claim shares the transaction, a confirm that fails after it
 * (the session ended, a database fault) rolls the claim back and leaves the
 * link usable. Any active user may confirm, staff or not.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @param raw - The raw token from the link.
 * @returns A new access token for the same session.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid`, an account gone or inactive, or a session that has ended; 400 `LINK_INVALID` for a link this session cannot use.
 */
export async function confirmStepUpLink(
  userId: string,
  sessionId: string | undefined,
  raw: string
): Promise<{ accessToken: string }> {
  if (sessionId === undefined) throw sessionEnded()
  const user = await activeAccount(userId)
  const outcome = await withTransaction(async (tx): Promise<Date | 'link_invalid'> => {
    // The user row first, as every step-up takes it (ARCHITECTURE.md, lock order), then the link row the claim writes.
    await userRepository.lockById(userId, 'no key update', tx)
    const claimed = await claimLinkToken(raw, 'step_up', { userId, sessionId }, tx)
    // Commits: a dead link stays spent, so one presentation is one attempt.
    if (!claimed) return 'link_invalid'
    const at = await markSessionReauthenticated(userId, sessionId, tx)
    await recordStepUp(userId, 'link', tx)
    return at
  })
  if (outcome === 'link_invalid') {
    throw new HttpError(LINK_INVALID_MESSAGE, 400, LINK_INVALID_CODE)
  }
  return { accessToken: signAccessToken(user, sessionId, outcome) }
}

/**
 * Start a step-up by passkey: issue a single-use challenge bound to the
 * caller and the session, and build the WebAuthn options naming the caller's
 * own passkeys.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @returns The challenge id for the verify call, and the options for the browser.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid` or an account gone or inactive; 409 `NO_PASSKEY` when the caller has no passkey.
 */
export async function startPasskeyStepUp(
  userId: string,
  sessionId: string | undefined
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  if (sessionId === undefined) throw sessionEnded()
  await activeAccount(userId)
  const passkeys = await userPasskeyRepository.listByUser(userId)
  if (passkeys.length === 0) {
    throw new HttpError(
      "You don't have a passkey yet. Use another method to confirm it's you.",
      409,
      NO_PASSKEY_CODE
    )
  }
  const { challengeId, challenge } = await issuePasskeyChallenge('step_up', { userId, sessionId })
  const options = await generateAuthenticationOptions({
    rpID: passkeyRelyingParty().rpId,
    // The stored challenge is already base64url; decode it so the options carry it unchanged.
    challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
    allowCredentials: passkeys.map((row) => ({
      id: row.credentialId,
      transports: knownTransports(row.transports),
    })),
    userVerification: 'required',
  })
  return { challengeId, options }
}

/**
 * Finish a step-up by passkey. The challenge is spent first (`step_up`, bound
 * to this user and session), then the response must name one of the caller's
 * own passkeys and verify; a credential of any other user is refused with the
 * same answer as a bad signature. One transaction then moves the session's
 * `authenticated_at` to now, stores the passkey's use and audits
 * `auth.step_up_confirmed` with `method: 'passkey'`; a new access token
 * carries the time. The refresh token is untouched: the session is the same.
 * @param userId - The authenticated caller.
 * @param sessionId - The caller's session (the token's `sid`); undefined for a token without one.
 * @param input - The challenge id and the browser's assertion response.
 * @param input.challengeId - The id the options call answered.
 * @param input.response - The browser's assertion response.
 * @returns A new access token for the same session.
 * @throws {HttpError} 401 `ACCESS_TOKEN_EXPIRED` for a token without `sid`, an account gone or inactive, or a session that has ended; 400 `PASSKEY_VERIFICATION_FAILED` for a never-verified account, a challenge that is missing, used, expired or not this session's, a credential that is not the caller's, and a response that does not verify.
 */
export async function finishPasskeyStepUp(
  userId: string,
  sessionId: string | undefined,
  input: { challengeId: string; response: unknown }
): Promise<{ accessToken: string }> {
  if (sessionId === undefined) throw sessionEnded()
  const user = await activeAccount(userId)
  const challenge = await consumePasskeyChallenge(input.challengeId, 'step_up', {
    userId,
    sessionId,
  })
  // A never-verified account may hold a squatter's passkey; only a claim by link clears it.
  if (challenge === undefined || user.emailVerifiedAt === null) throw passkeyVerificationFailed()
  const response = input.response as AuthenticationResponseJSON
  const stored = await userPasskeyRepository.findByCredentialId(response.id)
  if (stored?.userId !== userId) throw passkeyVerificationFailed()
  const { newCounter, credentialBackedUp } = await verifyStoredAssertion(
    stored,
    response,
    challenge
  )
  const at = await withTransaction(async (tx) => {
    // markSessionReauthenticated takes the user row lock and refuses an account gone or inactive.
    const authenticatedAt = await markSessionReauthenticated(userId, sessionId, tx)
    await userPasskeyRepository.recordUse(
      stored.id,
      { signCount: newCounter, backupState: credentialBackedUp, at: new Date() },
      tx
    )
    await recordStepUp(userId, 'passkey', tx)
    return authenticatedAt
  })
  return { accessToken: signAccessToken(user, sessionId, at) }
}
