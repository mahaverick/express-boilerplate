/**
 * @file Reading the claims of an OpenID Connect ID token without checking its
 * signature. That is sound only for a token this server received straight
 * from the provider's token endpoint over TLS (OIDC Core §3.1.3.7, step 6),
 * which is the one place step-up reads it; never decode a token a client
 * handed in this way.
 */
import { z } from 'zod'

/**
 * The ID token claims step-up reads. `auth_time` is optional in the token;
 * its absence is the caller's to judge.
 */
export interface IdTokenClaims {
  iss: string
  aud: string
  sub: string
  exp: number
  auth_time?: number
}

/**
 * The payload's shape: unknown claims pass through unread, and an audience
 * list is refused, since Google issues a single audience.
 */
const ID_TOKEN_CLAIMS_SCHEMA = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  auth_time: z.number().optional(),
})

/**
 * Decode an ID token's payload into the claims step-up reads.
 * @param idToken - The raw `header.payload.signature` token from the token endpoint.
 * @returns The claims, without any other the payload carries.
 * @throws {Error} When the token has not exactly three parts, its payload is not JSON, or a claim is missing or of the wrong type.
 */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const parts = idToken.split('.')
  const payload = parts[1]
  if (payload === undefined || payload === '' || parts.length !== 3) {
    throw new Error('An ID token has three parts')
  }
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  const { iss, aud, sub, exp, auth_time: authTime } = ID_TOKEN_CLAIMS_SCHEMA.parse(decoded)
  return { iss, aud, sub, exp, ...(authTime !== undefined && { auth_time: authTime }) }
}
