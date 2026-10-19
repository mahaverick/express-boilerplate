/**
 * @file Issuing, claiming and peeking the single-use links a mail carries
 * (`email_link_tokens`), and building the URLs they travel in. A link is 32
 * random bytes, base64url-encoded; only its SHA-256 hash is stored. A claim
 * spends the row before its expiry is judged, so one presentation is one
 * attempt.
 */
import { randomBytes } from 'node:crypto'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { EmailLinkToken, LinkTokenIntent } from '@/database/models/email-link-token.model'
import {
  EmailLinkTokenRepository,
  type LinkTokenBinding,
  type LiveLinkMatch,
} from '@/repositories/email-link-token.repository'
import { withTransaction } from '@/services/database.service'
import { hashToken } from '@/services/session.service'
import { frontendUrl } from '@/services/verification.service'

const emailLinkTokenRepository = new EmailLinkTokenRepository()

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
 * What a link is issued for. A `step_up` link names the user and session it
 * elevates; a `sign_in` link names neither, and only it carries a redirect.
 */
export interface IssueLinkTokenInput {
  intent: LinkTokenIntent
  email: string
  app: FrontendApp
  userId?: string
  sessionId?: string
  redirect?: string
}

/**
 * The live links a new one supersedes, from its input.
 * @param input - The link being issued, its address already lowercased.
 * @returns The address's sign-in links, or the session's step-up links.
 * @throws {Error} When a `step_up` link names no user or session: a caller's bug, refused before any write.
 */
function supersededBy(input: IssueLinkTokenInput): LiveLinkMatch {
  if (input.intent === 'sign_in') return { email: input.email, intent: 'sign_in' }
  if (input.userId === undefined || input.sessionId === undefined) {
    throw new Error('A step_up link needs its user and session')
  }
  return { userId: input.userId, sessionId: input.sessionId, intent: 'step_up' }
}

/**
 * Issue a link: revoke the live links it supersedes (every sign-in link of
 * the address, or every step-up link of the session) and insert the new
 * row, in one transaction serialised per address or session, so at most one
 * link of each stays live.
 * @param input - What the link is for. The address is stored lowercased.
 * @param ttlMs - How long the link is valid for, in milliseconds.
 * @returns The raw token for the mail, never stored, and the inserted row.
 */
export async function issueLinkToken(
  input: IssueLinkTokenInput,
  ttlMs: number
): Promise<{ raw: string; row: EmailLinkToken }> {
  const email = input.email.toLowerCase()
  const match = supersededBy({ ...input, email })
  const raw = randomBytes(LINK_TOKEN_BYTES).toString('base64url')
  const row = await withTransaction(async (tx) => {
    await emailLinkTokenRepository.lockIssueFor(match, tx)
    await emailLinkTokenRepository.revokeLiveFor(match, tx)
    return emailLinkTokenRepository.insert(
      {
        intent: input.intent,
        app: input.app,
        email,
        userId: input.userId,
        sessionId: input.sessionId,
        redirect: input.redirect,
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
 * @param bound - For a `step_up` link: the user and session presenting it; another session neither matches nor spends it.
 * @returns The claimed row, or undefined when the link is unknown, of another intent or session, already used or revoked, or expired.
 */
export async function claimLinkToken(
  raw: string,
  intent: LinkTokenIntent,
  bound?: LinkTokenBinding
): Promise<EmailLinkToken | undefined> {
  const claimed = await emailLinkTokenRepository.claimOnce(hashToken(raw), intent, bound)
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
): Promise<EmailLinkToken | undefined> {
  return emailLinkTokenRepository.findLiveByHash(hashToken(raw), intent)
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
 * @returns The absolute URL.
 */
export function buildSignInLinkUrl(
  raw: string,
  row: Pick<EmailLinkToken, 'email' | 'app' | 'redirect'>
): string {
  const url = frontendPageUrl(row.app, SIGN_IN_LINK_PATH)
  url.searchParams.set('token', raw)
  url.searchParams.set('email', row.email)
  if (row.redirect !== null) url.searchParams.set('redirect', row.redirect)
  return url.href
}

/**
 * The step-up link a mail carries: `<apex>/auth/confirm?token=…`.
 * @param raw - The raw token, never its hash.
 * @returns The absolute URL.
 */
export function buildStepUpConfirmUrl(raw: string): string {
  const url = frontendPageUrl('apex', STEP_UP_CONFIRM_PATH)
  url.searchParams.set('token', raw)
  return url.href
}
