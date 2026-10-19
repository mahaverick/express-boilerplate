/**
 * @file The frontend links mailed to a user: the configured origin of each
 * frontend (`frontendUrl`), the invitation accept link, and the name a
 * template greets an unnamed user by.
 */
import { getEnv, type Env } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import { withEmailUtm } from '@/utilities/utm.utilities'

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
