/**
 * @file The gate for `/platform` routes, the OPTIONS refusal that keeps
 * Express's automatic `Allow` answer from revealing them, and the log line
 * each successful staff write leaves. The platform role is read on every
 * request, with no cache, so a revocation takes effect on the next request.
 */
import type { NextFunction, Request, Response } from 'express'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { logger } from '@/services/logger.service'
import { getPlatformMembership } from '@/services/platform.service'

/**
 * Set on `response.locals` by `requirePlatformRole` when it admits the
 * caller; `logStaffWrites` logs only a response carrying it.
 */
const ADMITTED_LOCAL = 'isPlatformRoleAdmitted'

/**
 * Admit only staff whose platform role is at least `minimum`, and mark the
 * response admitted (`response.locals.isPlatformRoleAdmitted`). Anyone else
 * gets the same 404 as an unknown route, so the route can't be discovered.
 * Must run after `requireAuth`.
 * @param minimum - The lowest platform role admitted.
 * @returns An Express middleware.
 */
export function requirePlatformRole(
  minimum: MembershipRole
): (request: Request, response: Response, next: NextFunction) => Promise<void> {
  return async (request, response, next) => {
    try {
      const platformRole = request.user ? await getPlatformMembership(request.user.id) : undefined
      if (!platformRole || !isRoleAtLeast(platformRole, minimum)) {
        next(new HttpError('Not found', 404))
        return
      }
      response.locals[ADMITTED_LOCAL] = true
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Answer every OPTIONS request with the same 404 as an unknown route. Without
 * it, Express answers OPTIONS on a registered path itself, 200 with an
 * `Allow` header listing the path's methods, before any role gate runs. Only
 * an authenticated OPTIONS reaches it: `cors` ends an allowed-origin
 * preflight before the routers, and `requireAuth` refuses one without a
 * bearer token. Must run after `requireAuth` and before every route.
 * @param request - The incoming request.
 * @param _response - Unused.
 * @param next - Continues the chain, or receives the 404.
 */
export function refusePlatformOptions(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  if (request.method === 'OPTIONS') {
    next(new HttpError('Not found', 404))
    return
  }
  next()
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * A staff route's target in its path: `/platform/users/<id>` or
 * `/platform/tenants/<id>`.
 */
const STAFF_TARGET_PATH =
  /\/platform\/(?<collection>users|tenants)\/(?<id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:\/|$)/i

/**
 * Log one structured line per successful staff write, once the response is
 * sent: method, path, status, the actor's id, and the target's type and id
 * when the path names one. Never the body or the query string, so neither a
 * reason nor an address reaches the log.
 * Only a POST, PUT, PATCH or DELETE that `requirePlatformRole` admitted and
 * that finished below 400 is logged, so a caller the gate refused can't
 * write a line naming a target of their choice. A response whose client
 * went away before it finished emits no `finish` and is not logged either.
 * The audit log is the record; this line is for operators' dashboards and
 * alerts.
 * @param request - The incoming request, after `requireAuth`.
 * @param response - The response, watched for `finish`.
 * @param next - Continues the chain.
 */
export function logStaffWrites(request: Request, response: Response, next: NextFunction): void {
  if (WRITE_METHODS.has(request.method)) {
    response.on('finish', () => {
      if (response.statusCode >= 400 || response.locals[ADMITTED_LOCAL] !== true) return
      const path = request.originalUrl.split('?', 1)[0] ?? ''
      const target = STAFF_TARGET_PATH.exec(path)?.groups
      logger.info('Staff write', {
        method: request.method,
        path,
        status: response.statusCode,
        actorId: request.user?.id,
        ...(target && {
          targetType: target.collection === 'users' ? 'user' : 'tenant',
          targetId: target.id,
        }),
      })
    })
  }
  next()
}
