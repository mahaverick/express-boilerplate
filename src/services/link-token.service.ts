/**
 * @file Issuing, claiming and peeking the single-use links a mail carries
 * (the `sign_in_link`, `step_up_link` and `invitation_link` rows of
 * `user_tokens`), and building the URLs they travel in. A link is 32
 * random bytes, base64url-encoded; only its SHA-256 hash is stored. A claim
 * spends the row before its expiry is judged, so one presentation is one
 * attempt.
 */
import { randomBytes } from 'node:crypto'
import type { FrontendApp } from '@/constants/frontend.constants'
import {
  LINK_TOKEN_PURPOSES,
  type LinkTokenIntent,
  type UserToken,
} from '@/database/models/user-token.model'
import {
  UserTokenRepository,
  type LinkTokenBinding,
  type LiveLinkMatch,
} from '@/repositories/user-token.repository'
import { db, withTransaction, type DbExecutor } from '@/services/database.service'
import { frontendUrl } from '@/services/frontend-links.service'
import { hashToken } from '@/services/session.service'
import { withEmailUtm } from '@/utilities/utm.utilities'

const userTokenRepository = new UserTokenRepository()

/**
 * How many random bytes a link token carries: 256 bits, 43 base64url characters.
 */
const LINK_TOKEN_BYTES = 32

/**
 * The frontend page a sign-in link opens, relative to the app's origin.
 */
const SIGN_IN_LINK_PATH = 'auth/link'

/**
 * The Apex page a step-up link opens, relative to its origin.
 */
const STEP_UP_CONFIRM_PATH = 'auth/confirm'

/**
 * The frontend page an invitation confirm link opens, relative to its origin.
 */
const INVITATION_CONFIRM_PATH = 'invitations/confirm'

/**
 * The Security settings page, where a passkey is created and deleted. The
 * same path in both frontends.
 */
export const SECURITY_SETTINGS_PATH = 'settings/account/security'

/**
 * What a link is issued for. A `step_up` link names the user and session it
 * elevates; an `invitation` link names the invitation it joins; a `sign_in`
 * link names none of them, and only it carries a redirect.
 */
export interface IssueLinkTokenInput {
  intent: LinkTokenIntent
  email: string
  app: FrontendApp
  userId?: string
  sessionId?: string
  redirect?: string
  invitationId?: string
}

/**
 * The live links a new one supersedes, from its input.
 * @param input - The link being issued, its address already lowercased.
 * @returns The address's sign-in links, its confirm links for the same invitation, or the session's step-up links.
 * @throws {Error} When a `step_up` link names no user or session, or an `invitation` link no invitation: a caller's bug, refused before any write.
 */
function supersededBy(input: IssueLinkTokenInput): LiveLinkMatch {
  if (input.intent === 'sign_in') return { email: input.email, intent: 'sign_in' }
  if (input.intent === 'invitation') {
    if (input.invitationId === undefined) {
      throw new Error('An invitation link needs its invitation')
    }
    // Per invitation: a link for one workspace never revokes another's.
    return { email: input.email, invitationId: input.invitationId, intent: 'invitation' }
  }
  if (input.userId === undefined || input.sessionId === undefined) {
    throw new Error('A step_up link needs its user and session')
  }
  return { userId: input.userId, sessionId: input.sessionId, intent: 'step_up' }
}

/**
 * Issue a link: revoke the live links it supersedes (every sign-in link of
 * the address, the address's confirm links for the same invitation, or
 * every step-up link of the session) and insert the new row, in one
 * transaction serialised per address, invitation or session, so at most one
 * link of each stays live.
 * @param input - What the link is for. The address is stored lowercased.
 * @param ttlMs - How long the link is valid for, in milliseconds.
 * @returns The raw token for the mail, never stored, and the inserted row.
 */
export async function issueLinkToken(
  input: IssueLinkTokenInput,
  ttlMs: number
): Promise<{ raw: string; row: UserToken }> {
  const email = input.email.toLowerCase()
  const match = supersededBy({ ...input, email })
  const raw = randomBytes(LINK_TOKEN_BYTES).toString('base64url')
  const row = await withTransaction(async (tx) => {
    await userTokenRepository.lockLinkIssue(match, tx)
    await userTokenRepository.revokeLiveFor(match, tx)
    return userTokenRepository.create(
      {
        purpose: LINK_TOKEN_PURPOSES[input.intent],
        app: input.app,
        email,
        userId: input.userId,
        sessionId: input.sessionId,
        redirect: input.redirect,
        invitationId: input.invitationId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + ttlMs),
      },
      tx
    )
  })
  return { raw, row }
}

/**
 * Claim a link once, atomically. The row is spent before its expiry is
 * judged, so an expired link is used up and answers undefined.
 * @param raw - The raw token presented.
 * @param intent - The intent it must have been issued for.
 * @param bound - For a `step_up` link: the user and session presenting it, required; another session neither matches nor spends it.
 * @param executor - Where to run the claim: a caller's transaction, so a refusal decided after it rolls the claim back; the pool when omitted.
 * @returns The claimed row, or undefined when the link is unknown, of another intent or session, already used or revoked, or expired, or a step-up link presented without a binding.
 */
export async function claimLinkToken(
  raw: string,
  intent: LinkTokenIntent,
  bound?: LinkTokenBinding,
  executor: DbExecutor = db
): Promise<UserToken | undefined> {
  // A step-up link is only ever honoured for the session it elevates.
  if (intent === 'step_up' && bound === undefined) return undefined
  const claimed = await userTokenRepository.claimOnce(
    hashToken(raw),
    LINK_TOKEN_PURPOSES[intent],
    executor,
    bound
  )
  if (!claimed) return undefined
  if (claimed.expiresAt.getTime() <= Date.now()) return undefined
  return claimed
}

/**
 * Read a live link without spending it, so a refusal decided on it (a
 * maintenance mode, say) leaves the link usable later.
 * @param raw - The raw token presented.
 * @param intent - The intent it must have been issued for.
 * @returns The live, unexpired row, or undefined.
 */
export function peekLinkToken(
  raw: string,
  intent: LinkTokenIntent
): Promise<UserToken | undefined> {
  return userTokenRepository.findLiveByHash(hashToken(raw), LINK_TOKEN_PURPOSES[intent])
}

/**
 * An absolute URL for a page under one configured frontend origin. The
 * origin is joined with a trailing slash, so a path prefix in it survives.
 * @param app - The frontend.
 * @param pagePath - The page, relative to the origin.
 * @returns The URL, with no query yet.
 */
function frontendPageUrl(app: FrontendApp, pagePath: string): URL {
  const origin = frontendUrl(app)
  return new URL(pagePath, origin.endsWith('/') ? origin : `${origin}/`)
}

/**
 * The sign-in link a mail carries: `<frontend>/auth/link?token=…&email=…`,
 * with `&redirect=…` when the row stored one. The frontend reads `email` and
 * `redirect` only as hints; verify returns the stored redirect.
 * @param raw - The raw token, never its hash.
 * @param row - The issued row's address, frontend and redirect.
 * @param templateKey - The mail that carries the link: its key is the `utm_campaign`.
 * @returns The absolute URL, with UTM parameters after the link's own query.
 * @throws {Error} For a row with no app or address, which no link row is.
 */
export function buildSignInLinkUrl(
  raw: string,
  row: Pick<UserToken, 'email' | 'app' | 'redirect'>,
  templateKey: 'sign_in_link' | 'welcome'
): string {
  const { app, email } = row
  // Every link row has both (user_tokens_shape_check); anything else is a caller's bug.
  if (app === null || email === null)
    throw new Error('A sign-in link row has an app and an address')
  const url = frontendPageUrl(app, SIGN_IN_LINK_PATH)
  url.searchParams.set('token', raw)
  url.searchParams.set('email', email)
  if (row.redirect !== null) url.searchParams.set('redirect', row.redirect)
  return withEmailUtm(url.href, templateKey, 'text_link')
}

/**
 * The step-up link a mail carries: `<apex>/auth/confirm?token=…`.
 * @param raw - The raw token, never its hash.
 * @returns The absolute URL, with UTM parameters after the token.
 */
export function buildStepUpConfirmUrl(raw: string): string {
  const url = frontendPageUrl('apex', STEP_UP_CONFIRM_PATH)
  url.searchParams.set('token', raw)
  return withEmailUtm(url.href, 'step_up_link', 'text_link')
}

/**
 * The invitation confirm link a mail carries:
 * `<frontend>/invitations/confirm?token=…&email=…`. The frontend reads
 * `email` as a display hint and sends it back for the mismatch check; it
 * never carries the invitation's own token.
 * @param raw - The raw token, never its hash.
 * @param row - The issued row's address and frontend.
 * @returns The absolute URL, with UTM parameters after the link's own query.
 * @throws {Error} For a row with no app or address, which no link row is.
 */
export function buildInvitationConfirmUrl(
  raw: string,
  row: Pick<UserToken, 'email' | 'app'>
): string {
  const { app, email } = row
  // Every link row has both (user_tokens_shape_check); anything else is a caller's bug.
  if (app === null || email === null)
    throw new Error('An invitation confirm link row has an app and an address')
  const url = frontendPageUrl(app, INVITATION_CONFIRM_PATH)
  url.searchParams.set('token', raw)
  url.searchParams.set('email', email)
  return withEmailUtm(url.href, 'invitation_confirm', 'primary_button')
}

/**
 * The Security settings link a passkey mail carries:
 * `<frontend>/settings/account/security`. It holds no token: signing in is
 * the proof.
 * @param app - The frontend the passkey was created or deleted in.
 * @param templateKey - The mail that carries the link: its key is the `utm_campaign`.
 * @returns The absolute URL, with UTM parameters.
 */
export function buildSecuritySettingsUrl(
  app: FrontendApp,
  templateKey: 'passkey_created' | 'passkey_deleted'
): string {
  return withEmailUtm(
    frontendPageUrl(app, SECURITY_SETTINGS_PATH).href,
    templateKey,
    'primary_button'
  )
}
