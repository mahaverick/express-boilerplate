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
import type { AuthenticatedUser } from '@/middlewares/auth.middleware'

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional: this file's own header comment explains why `Request.user`'s type is expressed by extending `Express.User` rather than declaring `user` on `Request` directly
    interface User extends AuthenticatedUser {}

    interface Request {
      /**
       * Correlation id, set by requestId middleware.
       */
      id: string
    }
  }
}

export {}
