/**
 * @file The gate for `/platform` routes, and the log line each successful
 * staff write leaves. The platform role is read on every request, with no
 * cache, so a revocation takes effect on the next request.
 */
import type { NextFunction, Request, Response } from 'express'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
import { logger } from '@/services/logger.service'
import { getPlatformMembership } from '@/services/platform.service'

/**
 * Admit only staff whose platform role is at least `minimum`. Anyone else
 * gets the same 404 as an unknown route, so the route can't be discovered.
 * Must run after `requireAuth`.
 * @param minimum - The lowest platform role admitted.
 * @returns An Express middleware.
 */
export function requirePlatformRole(
  minimum: MembershipRole
): (request: Request, response: Response, next: NextFunction) => Promise<void> {
  return async (request, _response, next) => {
    try {
      const platformRole = request.user ? await getPlatformMembership(request.user.id) : undefined
      if (!platformRole || !isRoleAtLeast(platformRole, minimum)) {
        next(new HttpError('Not found', 404))
        return
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

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
 * The audit log is the record; this line is for operators' dashboards and
 * alerts. Reads and refused writes (a status of 400 or above) are not logged.
 * @param request - The incoming request, after `requireAuth`.
 * @param response - The response, watched for `finish`.
 * @param next - Continues the chain.
 */
export function logStaffWrites(request: Request, response: Response, next: NextFunction): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.on('finish', () => {
      if (response.statusCode >= 400) return
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
