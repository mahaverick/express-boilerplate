/**
 * @file A stand-in for the Google strategy that skips the OAuth2 dance and
 * succeeds at once, so the callback route runs over real HTTP without
 * reaching Google. It hands the callback what `passthroughGoogleProfile`
 * (passport.config.ts) hands it: the profile and the ID token the token
 * endpoint returned, if any. `configurePassport()` registers the real
 * strategy under `GOOGLE_STRATEGY_NAME` and `passport.use` overwrites a
 * registration, so a test swaps this in and calls `configurePassport()`
 * afterwards to restore the real one.
 */
import type passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'

/**
 * Succeeds with a fixed profile and ID token on every request it sees.
 */
export class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  /**
   * The fields are public because `authenticate`'s `this:
   * passport.StrategyCreated<...>` type is a mapped type passport's `.d.ts`
   * builds outside this class, which cannot see a `private` field.
   * @param profile - The Google profile the callback receives.
   * @param idToken - The raw ID token the callback receives; undefined for none.
   */
  constructor(
    readonly profile: GoogleProfile,
    readonly idToken?: string
  ) {}

  /**
   * Succeed with the fixed profile and ID token without contacting Google.
   * The cast mirrors `passthroughGoogleProfile`'s: `Express.User` is the JWT
   * principal type, but the real verify hands the callback this pair too.
   */
  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    // eslint-disable-next-line unicorn/no-undeclared-class-members -- `success` is never a member of THIS class; passport injects it at runtime onto the per-request instance `this` refers to (`StrategyCreatedStatic`, passport's own `.d.ts`), which is exactly what `authenticate`'s `this: passport.StrategyCreated<...>` parameter type documents.
    this.success({ profile: this.profile, idToken: this.idToken } as unknown as Express.User)
  }
}

/**
 * The claims a test puts in a fake ID token; any may be left out, or set to
 * undefined, which JSON drops, to test its absence.
 */
export interface FakeIdTokenClaims {
  iss?: string | undefined
  aud?: string | string[] | undefined
  sub?: string | undefined
  exp?: number | undefined
  iat?: number | undefined
  auth_time?: number | undefined
}

/**
 * A three-part JWT whose payload is `claims`, with a placeholder signature:
 * step-up decodes the payload without checking it, as an ID token straight
 * from the token endpoint allows.
 * @param claims - The payload.
 * @returns `header.payload.signature`, each part base64url-encoded.
 */
export function fakeIdToken(claims: FakeIdTokenClaims): string {
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.${Buffer.from('signature').toString('base64url')}`
}

/**
 * One JWT part: JSON, base64url-encoded.
 * @param value - The part's content.
 * @returns The encoded part.
 */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
