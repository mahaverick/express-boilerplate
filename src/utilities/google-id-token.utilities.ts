/**
 * @file Reading `auth_time` from the ID token in Google's token response,
 * for step-up. Pure, no I/O.
 */
import type { Profile as GoogleProfile } from 'passport-google-oauth20'

/**
 * The issuers Google signs ID tokens as.
 */
const GOOGLE_ISSUERS: ReadonlySet<unknown> = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
])

/**
 * A Google profile as the strategy's verify function hands it on: plus, when
 * the ID token vouches for one, when Google last authenticated the user.
 */
export type GoogleSignIn = GoogleProfile & { stepUpAuthTime?: number }

/**
 * The ID token's `auth_time`, in seconds since the epoch, when the token in
 * Google's token response names Google as issuer, this client as audience
 * and `profileId` as subject. The signature is not checked: the token came
 * straight from Google's token endpoint over TLS, authenticated with the
 * client secret, which OpenID Connect Core 3.1.3.7 (6) accepts in place of a
 * signature check. Anything missing or mismatched gives undefined, which
 * step-up treats as not re-authenticated.
 * @param tokenResponse - The token response passport-oauth2 hands the verify function.
 * @param profileId - The Google profile id the same response produced.
 * @param clientId - This deployment's GOOGLE_CLIENT_ID.
 * @returns The auth time, or undefined.
 */
export function stepUpAuthTimeFrom(
  tokenResponse: unknown,
  profileId: string,
  clientId: string
): number | undefined {
  const idToken = (tokenResponse as { id_token?: unknown } | undefined)?.id_token
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.', 2)[1]
  if (payload === undefined) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof claims !== 'object' || claims === null) return undefined
  const { iss, aud, sub, auth_time: authTime } = claims as Record<string, unknown>
  if (aud !== clientId || sub !== profileId || !GOOGLE_ISSUERS.has(iss)) return undefined
  return typeof authTime === 'number' ? authTime : undefined
}
