/**
 * @file The route template a request matched, for error tracking's
 * `http_route`. By the time an error reaches `errorHandler`, Express has
 * restored `request.baseUrl` to the app's (empty) base, so the router's mount
 * path is gone; only `request.route` survives. This middleware records the
 * base at the moment the router assigns `request.route`, while it still names
 * the mount, and `routeTemplateOf` joins the two. Parameter values in a mount
 * path (`/tenants/:id/onboarding`) are put back as their names, so a template
 * never carries an id.
 */
import type { NextFunction, Request, Response } from 'express'

/**
 * What `http_route` says when no route matched (the 404 catch-all, or a
 * failure in router-level middleware before matching).
 */
export const UNMATCHED_ROUTE = 'unmatched'

/**
 * The mount path and parameters seen when the request's route was assigned.
 */
interface MatchedBase {
  base: string
  /**
   * A copy of `request.params`; a wildcard parameter's value is an array.
   */
  params: Record<string, string | string[]>
}

const matchedBases = new WeakMap<Request, MatchedBase>()

/**
 * A path segment that is a UUID, the shape of every id this API puts in a
 * mount path. A fallback for a mount whose router does not merge its
 * parameters, so the value is not in `request.params`.
 */
const UUID_SEGMENT = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * Record the router base whenever Express assigns `request.route`. Mounted
 * once, ahead of every router.
 * @param request - The request.
 * @param _response - Unused.
 * @param next - Continues the chain.
 */
export function recordRouteTemplate(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const slot: { route: unknown } = { route: undefined }
  Object.defineProperty(request, 'route', {
    configurable: true,
    enumerable: true,
    get: () => slot.route,
    set: (route: unknown) => {
      slot.route = route
      matchedBases.set(request, { base: request.baseUrl, params: { ...request.params } })
    },
  })
  next()
}

/**
 * The parameter names a route path declares, such as `id` in `/:id/timeline`.
 * @param path - The route path.
 * @returns The names.
 */
function routeParameterNames(path: string): Set<string> {
  return new Set(Array.from(path.matchAll(/:(\w+)/g), (match) => match[1] ?? ''))
}

/**
 * A matched base with each parameter value put back as `:name`, and any
 * remaining UUID segment as `:id`.
 * @param matched - The base and parameters recorded at match time.
 * @param routeNames - The route's own parameter names, which never appear in the base.
 * @returns The templated base.
 */
function templatedBase(matched: MatchedBase, routeNames: Set<string>): string {
  const baseParameters = Object.entries(matched.params).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !routeNames.has(entry[0])
  )
  return matched.base
    .split('/')
    .map((segment) => {
      if (segment === '') return segment
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        // A malformed escape cannot equal a decoded parameter value.
      }
      const named = baseParameters.find(([, value]) => value === decoded)
      if (named) return `:${named[0]}`
      return UUID_SEGMENT.test(segment) ? ':id' : segment
    })
    .join('/')
}

/**
 * The template of the route a request matched: the router's mount path plus
 * the route path, such as `/api/v1/platform/users/:id/timeline`.
 * @param request - The request, as `errorHandler` receives it.
 * @returns The template, or `UNMATCHED_ROUTE` when no route matched.
 */
export function routeTemplateOf(request: Request): string {
  const route: unknown = request.route
  const path = (route as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string') return UNMATCHED_ROUTE
  const matched = matchedBases.get(request)
  const base = matched === undefined ? '' : templatedBase(matched, routeParameterNames(path))
  if (base !== '' && path === '/') return base
  return `${base}${path}`
}
