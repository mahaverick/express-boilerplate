/**
 * @file The maintenance-mode gate. Mounted in app.ts right after
 * `requestContext`, after `cors` (so a refusal carries the CORS grant and a
 * preflight never reaches it) and before every router, the webhook router,
 * the PostHog proxy and the body parsers. It decides by method and path
 * (`maintenanceVerdict`, maintenance-mode.constants.ts), from this replica's
 * in-memory mode; it never reads Postgres or Redis. It runs before
 * authentication, so on a route Apex calls (`staffPass`,
 * `MAINTENANCE_STAFF_ROUTES`) it only marks the refusal on the response, and
 * `requireAuth` answers it unless the caller is platform staff
 * (`maintenanceRefusalFor`).
 */
import type { NextFunction, Request, Response } from 'express'
import {
  classifyMaintenanceRoute,
  MAINTENANCE_MODE_HEADER,
  maintenanceVerdict,
} from '@/constants/maintenance-mode.constants'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getPlatformMembership } from '@/services/platform.service'

/**
 * Where the gate leaves a staff-pass refusal for `requireAuth` to decide.
 */
const STAFF_PASS_LOCAL = 'maintenanceModeStaffPassRefusal'

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
  const verdict = maintenanceVerdict(snapshot.mode, request.method, request.path)
  if (verdict === 'allow') {
    next()
    return
  }
  const refusal = new MaintenanceModeError(verdict, snapshot)
  if (classifyMaintenanceRoute(request.method, request.path)?.staffPass === true) {
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
  const refusal: unknown = (response as Partial<Response>).locals?.[STAFF_PASS_LOCAL]
  if (!(refusal instanceof MaintenanceModeError)) return undefined
  const platformRole = await getPlatformMembership(userId)
  return platformRole === null ? refusal : undefined
}
