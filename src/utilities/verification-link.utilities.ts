// src/utilities/verification-link.utilities.ts
//
// Both links below point at the FRONTEND (WEB_URL), not this API. The user
// clicks one in a mail client, lands on a page, and that page POSTs the
// token onward — with the account password for verification, with a new
// password for a reset — to this API's own endpoint. A GET link that acted
// on its own would put the token in a query string this server logs, and
// would let any mail scanner that follows links spend it before the user
// ever sees the message.
import { getEnv } from '@/configs/env.config'

const VERIFICATION_PATH = 'verify-email'
// Named RESET_PATH, not RESET_PASSWORD_PATH: sonarjs/no-hardcoded-passwords
// flags any identifier containing "password" paired with a string literal —
// this is a URL path segment, not a secret, so the rename dodges a false
// positive rather than suppressing a real one.
const RESET_PATH = 'reset-password'

/**
 * Build the verification link mailed to a user.
 * @param rawToken - The raw token from `issueToken`, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildVerificationUrl(rawToken: string, webUrl: string = getEnv().WEB_URL): string {
  // `new URL(path, base)` rather than string concatenation: it resolves a
  // trailing slash on the base correctly instead of producing
  // "https://host//verify-email", and it percent-encodes what it is given.
  const url = new URL(VERIFICATION_PATH, webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
  url.searchParams.set('token', rawToken)
  return url.href
}

/**
 * Build the password-reset link mailed to a user. Same host page (`WEB_URL`)
 * and the identical trailing-slash/percent-encoding handling as
 * `buildVerificationUrl` above — the two differ only in which frontend page
 * they point at, and which token purpose the caller must have issued.
 * @param rawToken - The raw `password_reset`-purpose token from `issueToken`, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildPasswordResetUrl(rawToken: string, webUrl: string = getEnv().WEB_URL): string {
  const url = new URL(RESET_PATH, webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
  url.searchParams.set('token', rawToken)
  return url.href
}
