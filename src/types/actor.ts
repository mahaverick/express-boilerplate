// src/types/actor.ts
//
// The authenticated caller of a service call, once request handling has
// resolved to "who is making this call" — E3 onward's service functions
// take this instead of Request/Response.

/**
 * The authenticated caller of a service call.
 */
export interface Actor {
  userId: string
}
