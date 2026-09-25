// src/middlewares/platform.middleware.ts
//
// The gate for /platform routes. The platform role is read on every request,
// with no cache, so a revocation takes effect on the next request.
import type { NextFunction, Request, Response } from 'express'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { isRoleAtLeast } from '@/policies/tenant.policy'
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
