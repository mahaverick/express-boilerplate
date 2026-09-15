// src/types/express.d.ts
//
// Declared once, globally, rather than in every file that reads `request.id`
// — Express's own `Request` interface is what every handler and middleware
// sees, so augmenting it here is the single source of truth.
import type { AuthenticatedUser } from '@/middlewares/auth.middleware'

declare global {
  namespace Express {
    interface Request {
      /**
       * Correlation id, set by requestId middleware.
       */
      id: string

      /**
       * The authenticated principal, set by requireAuth (auth.middleware.ts).
       * Optional — unlike `id`, requireAuth is not global middleware; it only
       * runs on routes that opt into it, so a public route's request never
       * gets one.
       */
      user?: AuthenticatedUser
    }
  }
}

export {}
