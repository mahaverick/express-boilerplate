/**
 * @file The frontend links mailed to a user, and `markEmailVerified`, the one
 * writer of `users.email_verified_at`. Every link that proves a mailbox
 * (a sign-in link, an invitation, Google's verified address) verifies the
 * account through it.
 */
import { getEnv, type Env } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { db, type DbExecutor } from '@/services/database.service'
import { withEmailUtm } from '@/utilities/utm.utilities'

const userRepository = new UserRepository()

const INVITATION_ACCEPT_PATH = 'invitations/accept'

/**
 * The name a template greets an unnamed user by. `firstName` is optional on an
 * account but required by every template that greets the user by name:
 * requireEmailVariables throws on a missing one and sendMail records that as
 * a failed delivery, so without a fallback the mail never arrives.
 */
export const MISSING_FIRST_NAME_FALLBACK = 'there'

/**
 * Build an absolute frontend URL for one page, carrying a raw token. Links
 * point at a frontend (`frontendUrl`), whose page POSTs the token to this
 * API: a GET link that acted by itself would put the token in this API's
 * request URL, which HTTP tracing (`url.query`) and proxy logs record, and a
 * mail scanner following links could spend it.
 * @param pagePath - The frontend page, relative to `webUrl`.
 * @param rawToken - The raw token, never its hash.
 * @param webUrl - The frontend origin.
 * @returns The absolute URL with `token` as a query parameter.
 */
function buildTokenUrl(pagePath: string, rawToken: string, webUrl: string): string {
  const url = new URL(pagePath, webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
  url.searchParams.set('token', rawToken)
  return url.href
}

/**
 * Build the invitation accept link mailed to an invitee. The page it opens
 * POSTs the token to `/invitations/preview` and then `/invitations/accept`.
 * @param rawToken - The raw invitation token, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter, then UTM parameters.
 */
export function buildInvitationAcceptUrl(
  rawToken: string,
  webUrl: string = getEnv().WEB_URL
): string {
  return withEmailUtm(
    buildTokenUrl(INVITATION_ACCEPT_PATH, rawToken, webUrl),
    'tenant_invitation',
    'primary_button'
  )
}

/**
 * The configured origin for one frontend. Always one of two configured
 * values, never request input, so choosing `app` cannot send a link anywhere else.
 * @param app - The frontend the link or redirect is for.
 * @param env - The configured origins; defaults to the validated environment.
 * @returns APEX_URL for 'apex' when it is set, WEB_URL otherwise.
 */
export function frontendUrl(
  app: FrontendApp,
  env: Pick<Env, 'WEB_URL' | 'APEX_URL'> = getEnv()
): string {
  return app === 'apex' && env.APEX_URL !== undefined ? env.APEX_URL : env.WEB_URL
}

/**
 * Mark a user's email verified. The only writer of users.email_verified_at;
 * a no-op when it is already set, so an earlier timestamp never moves. It
 * grants nothing: staff join the platform tenant only by invitation or the
 * bootstrap grant.
 * @param userId - The user whose mailbox has been proven.
 * @param executor - The pool, or the caller's transaction to join.
 * @returns The verified row when this call verified it, undefined when it already was (or is gone).
 */
export async function markEmailVerified(
  userId: string,
  executor: DbExecutor = db
): Promise<User | undefined> {
  return userRepository.markEmailVerified(userId, executor)
}
