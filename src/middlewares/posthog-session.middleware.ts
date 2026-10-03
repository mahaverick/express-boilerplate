/**
 * @file Copies the browser's PostHog session id from `X-POSTHOG-SESSION-ID`
 * into the request context, so a server analytics event can carry the
 * `$session_id` that links it to the session's replay.
 */
import type { NextFunction, Request, Response } from 'express'
import { POSTHOG_SESSION_ID_PATTERN } from '@/constants/analytics.constants'
import { requestContextStore } from '@/services/request-context.service'

/**
 * Record a well-formed `X-POSTHOG-SESSION-ID` on the current request
 * context. Anything that is not a single UUID is dropped silently: the id
 * only ever labels an analytics event, so a bad one is not worth a 400.
 * Runs right after `requestContext`, whose store it extends in place.
 * @param request - The request.
 * @param _response - Unused.
 * @param next - Continues the chain.
 */
export function posthogSession(request: Request, _response: Response, next: NextFunction): void {
  const header = request.headers['x-posthog-session-id']
  const context = requestContextStore.getStore()
  if (context && typeof header === 'string' && POSTHOG_SESSION_ID_PATTERN.test(header)) {
    context.posthogSessionId = header
  }
  next()
}
