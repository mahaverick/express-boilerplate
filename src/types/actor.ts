// src/types/actor.ts
//
// The authenticated caller of a service call, once request handling has
// resolved to "who is making this call" — services take this instead of
// Request/Response — and the tenant-scoped principal `resolveTenant`
// attaches to the request.
import type { TenantContext } from '@/services/request-context.service'

/**
 * The authenticated caller of a service call.
 */
export interface Actor {
  userId: string
}

/**
 * The tenant-scoped identity `resolveTenant` attaches to `request.principal`
 * once a caller is confirmed to belong to the tenant the route names.
 */
export type RequestPrincipal = TenantContext
