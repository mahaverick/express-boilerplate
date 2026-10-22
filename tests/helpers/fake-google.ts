/**
 * @file A stand-in for the Google strategy that skips the OAuth2 dance and
 * succeeds at once, so the callback route runs over real HTTP without
 * reaching Google. It hands the callback what `passthroughGoogleProfile`
 * (passport.config.ts) hands it: the raw profile. `configurePassport()`
 * registers the real strategy under `GOOGLE_STRATEGY_NAME` and `passport.use`
 * overwrites a registration, so a test swaps this in and calls
 * `configurePassport()` afterwards to restore the real one.
 */
import type passport from 'passport'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'

/**
 * Succeeds with a fixed profile on every request it sees.
 */
export class FakeGoogleSuccessStrategy implements passport.Strategy {
  name = GOOGLE_STRATEGY_NAME

  /**
   * The field is public because `authenticate`'s `this:
   * passport.StrategyCreated<...>` type is a mapped type passport's `.d.ts`
   * builds outside this class, which cannot see a `private` field.
   * @param profile - The Google profile the callback receives.
   */
  constructor(readonly profile: GoogleProfile) {}

  /**
   * Succeed with the fixed profile without contacting Google. The cast
   * mirrors `passthroughGoogleProfile`'s: `Express.User` is the JWT principal
   * type, but the real verify hands the callback the profile too.
   */
  authenticate(this: passport.StrategyCreated<FakeGoogleSuccessStrategy>): void {
    this.success(this.profile as unknown as Express.User)
  }
}
