/**
 * @file The fixed values of maintenance mode: its modes, header, timings,
 * text bounds and error codes. Everything new is named `maintenance-mode`;
 * the `maintenance` queue (the retention purge) is unrelated.
 */

/**
 * The modes, mirrored into `maintenance_mode_state_mode_check`.
 */
export const MAINTENANCE_MODES = ['off', 'read_only', 'full'] as const

/**
 * One of `MAINTENANCE_MODES`.
 */
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number]

/**
 * The response header carrying this replica's mode, on every response the
 * gate sees.
 */
export const MAINTENANCE_MODE_HEADER = 'Maintenance-Mode'

/**
 * How often each replica reloads the stored mode whether or not a change
 * message arrived: the backstop for a missed or lost Redis message.
 */
export const MAINTENANCE_MODE_RELOAD_INTERVAL_MS = 10_000

/**
 * The `Retry-After` value, in seconds, on every maintenance 503.
 */
export const MAINTENANCE_MODE_RETRY_AFTER_SECONDS = 30

/**
 * The one shared deadline a change into `full` waits for its notice jobs
 * before pausing the queues.
 */
export const MAINTENANCE_MODE_NOTICE_WAIT_MS = 10_000

/**
 * The longest customer message or internal reason, in characters.
 */
export const MAINTENANCE_MODE_TEXT_MAX_LENGTH = 500

/**
 * The 503 code for a request refused in `full`, and for a non-staff sign-in in `full`.
 */
export const MAINTENANCE_MODE_CODE = 'MAINTENANCE_MODE'

/**
 * The 503 code for a write refused in `read_only`.
 */
export const READ_ONLY_MODE_CODE = 'READ_ONLY_MODE'

/**
 * The 409 code for a change whose `expectedVersion` is not the stored version.
 */
export const MAINTENANCE_MODE_CONFLICT_CODE = 'MAINTENANCE_MODE_CONFLICT'

/**
 * The 400 code for switching on or escalating without `confirm` equal to `APP_ENV`.
 */
export const CONFIRMATION_MISMATCH_CODE = 'CONFIRMATION_MISMATCH'

/**
 * What one maintenance mode does to a classified route.
 */
export type MaintenanceRouteAccess = 'allow' | 'block'

/**
 * An HTTP method a rule names; `*` is any method.
 */
export type MaintenanceRuleMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*'

/**
 * One route's classification. `path` is the full Express path template
 * (`:name` matches one segment); a `prefix` rule also covers every path
 * below it. A `staffPass` route is one Apex calls: where the mode refuses
 * it, platform staff are still let through once `requireAuth` knows them.
 */
export interface MaintenanceRouteRule {
  method: MaintenanceRuleMethod
  path: string
  match: 'exact' | 'prefix'
  readOnly: MaintenanceRouteAccess
  full: MaintenanceRouteAccess
  staffPass: boolean
}

/**
 * The customer routes Apex calls outside `/platform/*` (its tenant,
 * members, invitations and Staff pages, a staff member's own profile and
 * password, and accepting an invitation), as `METHOD path`. Platform staff pass the gate on these in
 * both modes; everyone else is refused as on any route. Every one sits
 * behind `requireAuth`, which runs the staff check.
 * `tests/unit/routes/maintenance-mode-gates.test.ts` compares this list with
 * the calls in `tests/fixtures/apex-api-calls.json`, copied from apex; when
 * apex calls a new customer route, that fixture and this list change together.
 */
export const MAINTENANCE_STAFF_ROUTES: readonly string[] = [
  'PATCH /api/v1/profile',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/invitations/accept',
  'GET /api/v1/tenants/:slug',
  'PATCH /api/v1/tenants/:slug',
  'GET /api/v1/tenants/:slug/members',
  'PATCH /api/v1/tenants/:slug/members/:userId',
  'DELETE /api/v1/tenants/:slug/members/:userId',
  'GET /api/v1/tenants/:slug/invitations',
  'POST /api/v1/tenants/:slug/invitations',
  'POST /api/v1/tenants/:slug/invitations/:id/resend',
  'DELETE /api/v1/tenants/:slug/invitations/:id',
  'GET /api/v1/tenants/:slug/audit-log',
]

/**
 * Whether a route is one of `MAINTENANCE_STAFF_ROUTES`.
 * @param method - The method.
 * @param path - The path template.
 * @returns The answer.
 */
function isStaffRoute(method: MaintenanceRuleMethod, path: string): boolean {
  return MAINTENANCE_STAFF_ROUTES.includes(`${method} ${path}`)
}

/**
 * A route let through in both modes.
 * @param method - The method.
 * @param path - The path template.
 * @param match - Whether paths below it are covered too.
 * @returns The rule.
 */
function letThrough(
  method: MaintenanceRuleMethod,
  path: string,
  match: 'exact' | 'prefix' = 'exact'
): MaintenanceRouteRule {
  return { method, path, match, readOnly: 'allow', full: 'allow', staffPass: false }
}

/**
 * A read: let through in `read_only`, refused in `full`.
 * @param path - The path template.
 * @returns The rule.
 */
function read(path: string): MaintenanceRouteRule {
  return {
    method: 'GET',
    path,
    match: 'exact',
    readOnly: 'allow',
    full: 'block',
    staffPass: isStaffRoute('GET', path),
  }
}

/**
 * A write on the read-only allowlist: let through in `read_only`, refused in `full`.
 * @param method - The method.
 * @param path - The path template.
 * @returns The rule.
 */
function readOnlyWrite(method: MaintenanceRuleMethod, path: string): MaintenanceRouteRule {
  return { method, path, match: 'exact', readOnly: 'allow', full: 'block', staffPass: false }
}

/**
 * A write refused in both modes.
 * @param method - The method.
 * @param path - The path template.
 * @returns The rule.
 */
function write(method: MaintenanceRuleMethod, path: string): MaintenanceRouteRule {
  return {
    method,
    path,
    match: 'exact',
    readOnly: 'block',
    full: 'block',
    staffPass: isStaffRoute(method, path),
  }
}

/**
 * Every route's maintenance classification: the one place it is decided.
 * `tests/unit/routes/maintenance-mode-gates.test.ts` walks the app and fails
 * on a route no rule covers and on a rule that covers no route, so a new
 * route needs its row here. The gate decides by method and path, except on
 * a `staffPass` route, where `requireAuth` finishes the decision by the
 * caller's platform role; a path no rule covers (an unknown route) gets the
 * default: reads let through in `read_only`, everything refused in `full`.
 */
export const MAINTENANCE_ROUTE_RULES: readonly MaintenanceRouteRule[] = [
  // Always let through: liveness, readiness, provider webhooks, the PostHog proxy, this status, staff.
  letThrough('GET', '/health'),
  letThrough('GET', '/health/ready'),
  letThrough('*', '/api/v1/webhooks/email', 'prefix'),
  letThrough('*', '/api/v1/collect', 'prefix'),
  letThrough('GET', '/api/v1/status/maintenance'),
  letThrough('*', '/api/v1/platform', 'prefix'),
  // Sign-in: let through; in `full` the auth service refuses non-staff after identifying them.
  letThrough('POST', '/api/v1/auth/login'),
  letThrough('GET', '/api/v1/auth/google'),
  letThrough('GET', '/api/v1/auth/google/callback'),
  // Sessions are kept in both modes.
  letThrough('POST', '/api/v1/auth/refresh'),
  letThrough('POST', '/api/v1/auth/logout'),
  letThrough('POST', '/api/v1/auth/reauthenticate'),
  letThrough('GET', '/api/v1/auth/providers'),
  // Both frontends read the profile after every token refresh and sign-in; without it no session is restored.
  letThrough('GET', '/api/v1/profile'),
  // Account writes: refused in both modes.
  write('POST', '/api/v1/auth/register'),
  write('POST', '/api/v1/auth/verify-email'),
  write('POST', '/api/v1/auth/resend-verification'),
  write('POST', '/api/v1/auth/forgot-password'),
  write('POST', '/api/v1/auth/reset-password'),
  write('POST', '/api/v1/auth/change-password'),
  write('PATCH', '/api/v1/profile'),
  read('/api/v1/notifications/stream'),
  read('/api/v1/notifications'),
  write('PATCH', '/api/v1/notifications/:id/read'),
  write('PATCH', '/api/v1/notifications/read-all'),
  write('DELETE', '/api/v1/notifications/:id'),
  read('/api/v1/notifications/preferences'),
  write('PUT', '/api/v1/notifications/preferences'),
  write('POST', '/api/v1/tenants'),
  read('/api/v1/tenants'),
  read('/api/v1/tenants/:slug'),
  write('PATCH', '/api/v1/tenants/:slug'),
  read('/api/v1/tenants/:slug/members'),
  write('PATCH', '/api/v1/tenants/:slug/members/:userId'),
  write('DELETE', '/api/v1/tenants/:slug/members/:userId'),
  read('/api/v1/tenants/:slug/invitations'),
  write('POST', '/api/v1/tenants/:slug/invitations'),
  write('POST', '/api/v1/tenants/:slug/invitations/:id/resend'),
  write('DELETE', '/api/v1/tenants/:slug/invitations/:id'),
  read('/api/v1/tenants/:slug/settings'),
  write('PATCH', '/api/v1/tenants/:slug/settings'),
  read('/api/v1/tenants/:slug/onboarding'),
  write('POST', '/api/v1/tenants/:slug/onboarding/steps/:key/complete'),
  write('POST', '/api/v1/tenants/:slug/onboarding/dismiss'),
  write('POST', '/api/v1/tenants/:slug/onboarding/undismiss'),
  read('/api/v1/tenants/:slug/audit-log'),
  read('/api/v1/tenants/:slug/flags'),
  // Flag exposure recording: telemetry, on the read-only allowlist.
  readOnlyWrite('POST', '/api/v1/tenants/:slug/flags/exposures'),
  read('/api/v1/tenants/:slug/beta'),
  write('POST', '/api/v1/invitations/preview'),
  write('POST', '/api/v1/invitations/accept'),
  read('/api/v1/flags'),
  readOnlyWrite('POST', '/api/v1/flags/exposures'),
]

/**
 * A rule's path template as a case-insensitive pattern: Express matches
 * paths case-insensitively and with an optional trailing slash, and so does
 * this.
 * @param rule - The rule.
 * @returns The pattern.
 */
function patternOf(rule: MaintenanceRouteRule): RegExp {
  const body = rule.path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
    )
    .join('/')
  return new RegExp(rule.match === 'prefix' ? `^${body}(?:/.*)?$` : `^${body}/?$`, 'i')
}

const COMPILED_RULES = MAINTENANCE_ROUTE_RULES.map((rule) => ({ rule, pattern: patternOf(rule) }))

/**
 * The rule covering one request, or undefined when none does. HEAD is
 * classified as GET, as Express routes it.
 * @param method - The request method.
 * @param path - The request path, without the query string.
 * @returns The first matching rule.
 */
export function classifyMaintenanceRoute(
  method: string,
  path: string
): MaintenanceRouteRule | undefined {
  const upper = method.toUpperCase()
  const effective = upper === 'HEAD' ? 'GET' : upper
  return COMPILED_RULES.find(
    ({ rule, pattern }) => (rule.method === '*' || rule.method === effective) && pattern.test(path)
  )?.rule
}

/**
 * What the gate does with one request in one mode: let it through, or
 * refuse it with the mode's code. `OPTIONS` is always let through (`cors`
 * answers preflights before the gate; any other OPTIONS is Express's own).
 * @param mode - This replica's mode.
 * @param method - The request method.
 * @param path - The request path, without the query string.
 * @returns `'allow'`, `MAINTENANCE_MODE_CODE` or `READ_ONLY_MODE_CODE`.
 */
export function maintenanceVerdict(
  mode: MaintenanceMode,
  method: string,
  path: string
): 'allow' | typeof MAINTENANCE_MODE_CODE | typeof READ_ONLY_MODE_CODE {
  const upper = method.toUpperCase()
  if (mode === 'off' || upper === 'OPTIONS') return 'allow'
  const rule = classifyMaintenanceRoute(upper, path)
  if (mode === 'read_only') {
    const isRead = upper === 'GET' || upper === 'HEAD'
    const access = rule?.readOnly ?? (isRead ? 'allow' : 'block')
    return access === 'allow' ? 'allow' : READ_ONLY_MODE_CODE
  }
  return rule?.full === 'allow' ? 'allow' : MAINTENANCE_MODE_CODE
}
