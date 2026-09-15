// src/types/express.d.ts
//
// Declared once, globally, rather than in every file that reads `request.id`
// — Express's own `Request` interface is what every handler and middleware
// sees, so augmenting it here is the single source of truth.
declare global {
  namespace Express {
    interface Request {
      /**
       * Correlation id, set by requestId middleware.
       */
      id: string
    }
  }
}

export {}
