// src/controllers/helpers.controller.ts
//
// Unifies 6 identical private authenticatedUserId copies (auth,
// invitation, notification, notification-stream, profile, tenant
// controllers) plus actorFrom, the shape a service call takes from E3
// onward instead of Request.
import type { Request } from 'express'
import { HttpError } from '@/errors/http-error'
import type { Actor } from '@/types/actor'

/**
 * The authenticated principal's id, guarding against a route reaching a
 * controller without `requireAuth` ahead of it.
 * @param request - The incoming request.
 * @returns The authenticated user's id.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
export function authenticatedUserId(request: Request): string {
  if (!request.user) {
    throw new HttpError('Authentication required', 401)
  }
  return request.user.id
}

/**
 * The authenticated caller, as the `Actor` a service call takes.
 * @param request - The incoming request.
 * @returns The caller's Actor.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
export function actorFrom(request: Request): Actor {
  return { userId: authenticatedUserId(request) }
}
