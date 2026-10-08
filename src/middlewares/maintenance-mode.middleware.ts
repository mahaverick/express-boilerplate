/**
 * @file The maintenance-mode gate. Mounted in app.ts right after
 * `requestContext`, after `cors` (so a refusal carries the CORS grant and a
 * preflight never reaches it) and before every router, the webhook router,
 * the PostHog proxy and the body parsers. It decides by method and path
 * (`maintenanceDecision`, maintenance-mode.constants.ts), from this replica's
 * in-memory mode; it never reads Postgres or Redis. It runs before
 * authentication, so on a route Apex calls (`staffPass`,
 * `MAINTENANCE_STAFF_ROUTES`) it only marks the refusal on the response, and
 * `requireAuth` answers it unless the caller is platform staff
 * (`maintenanceRefusalFor`), which leaves the role it read on the response
 * for the tenant and platform gates of the same request.
 */
import type { NextFunction, Request, Response } from 'express'
import {
  MAINTENANCE_MODE_HEADER,
  maintenanceDecision,
} from '@/constants/maintenance-mode.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getPlatformMembership } from '@/services/platform.service'

/**
 * Where the gate leaves a staff-pass refusal for `requireAuth` to decide.
 */
const STAFF_PASS_LOCAL = 'maintenanceModeStaffPassRefusal'

/**
 * Where `maintenanceRefusalFor` leaves the platform role it read, with the
 * user it was read for.
 */
const PLATFORM_ROLE_LOCAL = 'maintenanceModePlatformRole'

/**
 * A platform role read earlier in this request.
 */
interface PlatformRoleRead {
  userId: string
  role: MembershipRole | null
}

/**
 * Stamp `Maintenance-Mode` on the response (it stays on whatever answers
 * later, an error included), then let the request through or refuse it with
 * a `MaintenanceModeError`, which `errorHandler` writes as a 503.
 * @param request - The incoming request.
 * @param response - The response the header goes on.
 * @param next - Continues the chain, or receives the refusal.
 */
export function maintenanceModeGate(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  const snapshot = getMaintenanceMode()
  response.setHeader(MAINTENANCE_MODE_HEADER, snapshot.mode)
  const { verdict, rule } = maintenanceDecision(snapshot.mode, request.method, request.path)
  if (verdict === 'allow') {
    next()
    return
  }
  const refusal = new MaintenanceModeError(verdict, snapshot)
  if (rule?.staffPass === true) {
    response.locals[STAFF_PASS_LOCAL] = refusal
    next()
    return
  }
  next(refusal)
}

/**
 * The refusal the gate left on a staff-pass route, unless the authenticated
 * caller holds a platform role. Called by `requireAuth` once it knows the user.
 * @param userId - The authenticated caller.
 * @param response - The response the gate marked, or did not.
 * @returns The refusal to answer, or undefined to let the request through.
 */
export async function maintenanceRefusalFor(
  userId: string,
  response: Response
): Promise<MaintenanceModeError | undefined> {
  // Optional: a caller that built no Express response (a direct test of requireAuth) has no locals.
  const locals = (response as Partial<Response>).locals
  const refusal: unknown = locals?.[STAFF_PASS_LOCAL]
  if (!(refusal instanceof MaintenanceModeError)) return undefined
  const platformRole = await getPlatformMembership(userId)
  if (locals)
    locals[PLATFORM_ROLE_LOCAL] = { userId, role: platformRole } satisfies PlatformRoleRead
  return platformRole === null ? refusal : undefined
}

/**
 * The caller's platform role, reusing the read `maintenanceRefusalFor` made
 * earlier in this request (a staff-pass route in maintenance) instead of a
 * second query. Read once per request either way, so a revoked role still
 * takes effect on the next request.
 * @param userId - The authenticated caller.
 * @param response - This request's response, whose locals may hold the read.
 * @returns The platform role, or null when the caller has none.
 */
export async function platformRoleOf(
  userId: string,
  response: Response
): Promise<MembershipRole | null> {
  const earlier = (response as Partial<Response>).locals?.[PLATFORM_ROLE_LOCAL] as
    PlatformRoleRead | undefined
  if (earlier?.userId === userId) return earlier.role
  return getPlatformMembership(userId)
}
