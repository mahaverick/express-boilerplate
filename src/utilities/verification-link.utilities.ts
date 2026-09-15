// src/utilities/verification-link.utilities.ts
//
// The verification link points at the FRONTEND (WEB_URL), not this API.
// The user clicks it in a mail client, lands on a page, and that page
// POSTs the token — with the account password — to
// POST /api/v1/auth/verify-email. A GET link that verified on its own
// would put the token in a query string this server logs, and would let
// any mail scanner that follows links spend it before the user ever sees
// the message.
import { getEnv } from '@/configs/env.config'

const VERIFICATION_PATH = 'verify-email'

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
