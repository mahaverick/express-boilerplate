/**
 * @file The global augmentation of Express's `Request`. `request.user` is
 * typed by extending `Express.User`, not by declaring `user` on `Request`:
 * `@types/passport` already declares `Request.user?: User`, and a second
 * declaration of a different type would be arbitrated silently under
 * `skipLibCheck`, leaving `request.user` typed as passport's empty `User`.
 */
import type { AuthenticatedUser } from '@/presenters/user.presenter'
import type { RequestPrincipal } from '@/types/actor'

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- empty on purpose: extending `Express.User` types passport's own `Request.user` declaration
    interface User extends AuthenticatedUser {}

    interface Request {
      /**
       * Correlation id, set by requestId middleware.
       */
      id: string

      /**
       * The caller's tenant-scoped identity, set by `resolveTenant`
       * (tenant.middleware.ts) once it confirms the caller has access to the
       * tenant the route names, as a member or through their platform role.
       * Absent on every request that does not pass through `resolveTenant`.
       * Kept apart from `user`, which is the client-visible projection
       * (`GET /api/v1/profile` returns it verbatim) and must never carry a
       * role or tenant id.
       */
      principal?: RequestPrincipal

      /**
       * The access token's `sid` claim, set by `requireAuth`
       * (auth.middleware.ts) from the payload it has already verified.
       * Absent (never `undefined`, under `exactOptionalPropertyTypes`) on a
       * request that did not pass through `requireAuth`, or whose verified
       * token carries no `sid` claim. Not express-session's `sessionID`, which
       * is the OAuth round-trip's cookie-store id.
       *
       * Lets a handler after `requireAuth`, such as `streamNotifications`
       * (notification-stream.controller.ts), read the verified session id
       * without verifying the token again. That handler rejects a request
       * without one (`requireSessionId`).
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

      /**
       * When the session behind the verified access token last
       * authenticated, in seconds since the epoch: its `auth_time` claim,
       * set by `requireAuth`. Absent when the token carried none.
       * `requireRecentAuth` (auth.middleware.ts) reads it.
       */
      authTime?: number
    }
  }
}

export {}
