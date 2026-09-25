// src/types/express.d.ts
//
// Declared once, globally, rather than in every file that reads `request.id`
// — Express's own `Request` interface is what every handler and middleware
// sees, so augmenting it here is the single source of truth.
//
// `Request.user` is declared by EXTENDING `Express.User`, not by adding a
// `user` property to `Request` directly the way `id` is below. That used to
// be how this file did it too, until installing `passport` for Google OAuth
// (passport.config.ts) broke it: `@types/passport`'s own global augmentation
// (loaded automatically for every file in the program the moment the
// package sits in node_modules — not only files that `import 'passport'`)
// ALSO declares `interface Request { user?: User | undefined; ... }` on the
// same merged `Express` namespace. Two declarations of `user` with
// genuinely different types on the same merged interface is ordinarily a
// TS2717 compile error ("Subsequent property declarations must have the
// same type") — the reason it did NOT surface here is `skipLibCheck: true`
// (tsconfig.json): it skips type-checking `.d.ts` files entirely, including
// this project's OWN `src/types/express.d.ts`, so the conflict between the
// two declarations was never validated, and whichever one TypeScript's
// merge algorithm happened to resolve last silently won for every ordinary
// `.ts` file's `request.user` reads. In this codebase that turned out to be
// passport's empty `Express.User`, not this project's `AuthenticatedUser` —
// `request.user` project-wide (profile.controller.ts, notification.
// controller.ts) resolved to `User` instead, so every `request.user.id`
// read broke at once (verified by temporarily reverting this file and
// re-running `tsc -p tsconfig.typecheck.json`: both call sites failed with
// "Property 'id' does not exist on type 'User'"). Declaring
// `interface User extends AuthenticatedUser {}` instead is the idiomatic
// fix wherever Passport-typed code shares a request project: passport's own
// `Request.user?: User | undefined` becomes the ONLY declaration of that
// property, and its type is exactly `AuthenticatedUser` because `User`
// extends it — so there is no second, conflicting declaration left for
// `skipLibCheck` to silently arbitrate between.
import type { AuthenticatedUser } from '@/presenters/user.presenter'
import type { RequestPrincipal } from '@/types/actor'

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional: this file's own header comment explains why `Request.user`'s type is expressed by extending `Express.User` rather than declaring `user` on `Request` directly
    interface User extends AuthenticatedUser {}

    interface Request {
      /**
       * Correlation id, set by requestId middleware.
       */
      id: string

      /**
       * The caller's tenant-scoped identity, set by `resolveTenant`
       * (tenant.middleware.ts) once it confirms the caller belongs to the
       * tenant the route names. Absent on every request that does not pass
       * through `resolveTenant` — most of them.
       *
       * A SEPARATE property from `user`, not folded into it: `user` is
       * `AuthenticatedUser`, and that interface's own header comment already
       * warns that server-only principal data (a role, a tenant id) must
       * never be added there — it is the CLIENT-VISIBLE projection
       * (`GET /api/v1/profile` returns it verbatim). `principal` does not
       * collide with `@types/passport`'s own global `Request` augmentation
       * (which declares only `user`, `login`/`logout`, `isAuthenticated`,
       * `isUnauthenticated`, and session helpers — no `principal`), so this
       * declaration is the only one for this property, the same guarantee
       * `id` above already has.
       */
      principal?: RequestPrincipal

      /**
       * The access token's `sid` claim, set by `requireAuth`
       * (auth.middleware.ts) from the payload it has already verified.
       * Absent on a request that did not pass through `requireAuth`, and
       * also absent — never set to `undefined`; `exactOptionalPropertyTypes`
       * (tsconfig.json) forbids that — when the token itself verified but
       * carries no `sid` claim at all (a token minted before that claim
       * existed; see `requireAuth`'s own `payload.sid &&` guard for the
       * tolerance this supports).
       *
       * NOT the same property as `sessionID` (capital ID) —
       * `@types/express-session`'s own global `Request` augmentation
       * declares that one, and it is express-session's cookie-store session
       * id, used only for the OAuth callback's short-lived session (see
       * CLAUDE.md's OAuth section). The two coexist on the same merged
       * `Request` without colliding only because they are spelled
       * differently, not because either file is "the" declaration the way
       * `principal` above is for its own name.
       *
       * Exists so a handler downstream of `requireAuth` — today only
       * `notification-stream.controller.ts`'s `streamNotifications` — can
       * read the verified session id without re-verifying the token a
       * second time, which is how two copies of the same check would drift.
       * See `requireSessionId`'s own comment (notification-stream.controller.ts)
       * for why that one handler has no tolerance for this being absent,
       * unlike `requireAuth` itself.
       */
      sessionId?: string

      /**
       * When the verified access token expires, set by `requireAuth` from
       * its `exp` claim. Absent when the token carried none. The
       * notification stream ends itself at this moment, so a reconnect
       * re-runs `requireAuth` (deactivation, denylist) at least once per
       * access-token lifetime.
       */
      accessTokenExpiresAt?: Date
    }
  }
}

export {}
