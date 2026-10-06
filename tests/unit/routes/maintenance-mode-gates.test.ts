/**
 * @file Walks the live app's routes (Google OAuth enabled, so its routes are
 * mounted) and checks them against `MAINTENANCE_ROUTE_RULES`: every route is
 * covered by a rule, every rule covers a route, the let-through set and the
 * read-only write allowlist are exactly spec §4.3's, and every read is let
 * through in `read_only`. A mount under one of the let-through prefixes
 * (`/api/v1/platform`, the webhooks, the PostHog proxy) counts as one entry,
 * since the prefix rule covers everything below it. Synthetic apps prove the
 * walk fails on an unclassified route and on a stale rule. The staff-pass
 * routes (`MAINTENANCE_STAFF_ROUTES`) must each sit behind `requireAuth`,
 * which finishes their decision, and must be exactly the authenticated
 * customer routes apex calls (`tests/fixtures/apex-api-calls.json`).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express, { Router, type Express, type RequestHandler } from 'express'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  classifyMaintenanceRoute,
  MAINTENANCE_ROUTE_RULES,
  MAINTENANCE_STAFF_ROUTES,
  type MaintenanceRouteRule,
} from '@/constants/maintenance-mode.constants'

interface StackLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] }
  handle: { stack?: StackLayer[] }
  path?: string
  match(path: string): boolean
}

/**
 * One walked route, or one mount under a let-through prefix (`method: '*'`).
 */
interface WalkedEntry {
  method: string
  path: string
  /**
   * Whether `requireAuth` runs before the route's handler.
   */
  isBehindAuth: boolean
}

/**
 * Every mount path a router is mounted at, under the app or under `/api/v1`.
 * A router mounted anywhere else makes the walk throw, so no route can hide.
 */
/**
 * The walked app and the `requireAuth` its routers use, both loaded in `beforeAll`.
 */
const live: { entries: WalkedEntry[]; requireAuth: unknown } = {
  entries: [],
  requireAuth: undefined,
}

const KNOWN_MOUNTS = [
  '/api/v1',
  '/api/v1/webhooks/email',
  '/api/v1/collect',
  '/auth',
  '/profile',
  '/notifications',
  '/tenants',
  '/invitations',
  '/platform',
  '/flags',
  '/status',
] as const

const PREFIX_PATHS = new Set(
  MAINTENANCE_ROUTE_RULES.filter((rule) => rule.match === 'prefix').map((rule) => rule.path)
)

const noop: RequestHandler = (_request, response) => {
  response.end()
}

/**
 * The routes a router stack registers, with full paths, recursing into
 * mounted routers; a mount at a let-through prefix is one `*` entry.
 * @param stack - A router's layers.
 * @param prefix - The mount path the layers sit under.
 * @param isAuthed - Whether `requireAuth` already ran on every request that reaches this router.
 * @returns The entries.
 * @throws {Error} When a router is mounted at a path not in `KNOWN_MOUNTS`.
 */
function entriesIn(stack: StackLayer[], prefix: string, isAuthed = false): WalkedEntry[] {
  let isAuthedHere = isAuthed
  return stack.flatMap((layer) => {
    if (layer.route) {
      const { path: routePath, methods, stack: handlers } = layer.route
      const isBehindAuth =
        isAuthedHere || handlers.some(({ handle }) => handle === live.requireAuth)
      return Object.keys(methods).map((method) => ({
        method: method.toUpperCase(),
        path: `${prefix}${routePath === '/' ? '' : routePath}`,
        isBehindAuth,
      }))
    }
    if (!Array.isArray(layer.handle.stack)) {
      if ((layer.handle as unknown) === live.requireAuth) isAuthedHere = true
      return []
    }
    const mount = KNOWN_MOUNTS.find(
      (candidate) => layer.match(candidate) && layer.path === candidate
    )
    if (mount === undefined) throw new Error('a router is mounted at an unknown path')
    const full = `${prefix}${mount}`
    if (PREFIX_PATHS.has(full)) return [{ method: '*', path: full, isBehindAuth: isAuthedHere }]
    return entriesIn(layer.handle.stack, full, isAuthedHere)
  })
}

/**
 * Walk an app.
 * @param app - The app.
 * @returns Its entries.
 */
function entriesOf(app: Express): WalkedEntry[] {
  return entriesIn((app as unknown as { router: { stack: StackLayer[] } }).router.stack, '')
}

/**
 * The rule an entry falls under: the prefix rule for a `*` mount, else the
 * rule whose path is exactly the entry's route template (a rule never
 * covers a different template that merely matches its pattern, so a literal
 * route beside a parameterised one needs a row of its own).
 * @param entry - The entry.
 * @param rules - The rule list to look in.
 * @returns The rule, or undefined.
 */
function ruleFor(
  entry: WalkedEntry,
  rules: readonly MaintenanceRouteRule[] = MAINTENANCE_ROUTE_RULES
): MaintenanceRouteRule | undefined {
  if (entry.method === '*') {
    return rules.find((rule) => rule.match === 'prefix' && rule.path === entry.path)
  }
  return rules.find(
    (rule) =>
      rule.match === 'exact' &&
      rule.path === entry.path &&
      (rule.method === '*' || rule.method === entry.method)
  )
}

/**
 * The walked routes the gate would classify by another rule than their own:
 * it takes the first rule whose pattern matches, so an earlier parameterised
 * rule shadows a later literal one.
 * @param entries - The walked entries.
 * @param rules - The rule list the gate would use.
 * @returns `METHOD path` for each.
 */
function shadowed(entries: WalkedEntry[], rules: readonly MaintenanceRouteRule[]): string[] {
  return entries
    .filter((entry) => entry.method !== '*')
    .filter(
      (entry) => classifyMaintenanceRoute(entry.method, entry.path, rules) !== ruleFor(entry, rules)
    )
    .map((entry) => `${entry.method} ${entry.path}`)
}

/**
 * The entries no rule covers.
 * @param entries - The walked entries.
 * @returns `METHOD path` for each.
 */
function unclassified(entries: WalkedEntry[]): string[] {
  return entries
    .filter((entry) => ruleFor(entry) === undefined)
    .map((entry) => `${entry.method} ${entry.path}`)
}

/**
 * The rules that cover no entry: a route they named is gone.
 * @param entries - The walked entries.
 * @returns `METHOD path` for each.
 */
function staleRules(entries: WalkedEntry[]): string[] {
  const used = new Set(entries.map((entry) => ruleFor(entry)))
  return MAINTENANCE_ROUTE_RULES.filter((rule) => !used.has(rule)).map(
    (rule) => `${rule.method} ${rule.path}`
  )
}

const byText = (a: string, b: string): number => a.localeCompare(b)

/**
 * A `METHOD path` with every parameter renamed, so apex's names and express's compare equal.
 * @param call - `METHOD path`.
 * @returns The shape.
 */
function shapeOf(call: string): string {
  return call.replaceAll(/:\w+/g, ':param')
}

/**
 * The apex calls that run before sign-in, so no staff check can apply:
 * they keep spec §4.3's auth table.
 */
const PRE_SIGN_IN_CALLS = new Set([
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/invitations/preview',
])

beforeAll(async () => {
  // Before the first getEnv(): the app is imported here, not at the top, so the Google routes mount.
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
  const { createApp } = await import('@/app')
  const auth = await import('@/middlewares/auth.middleware')
  live.requireAuth = auth.requireAuth
  live.entries = entriesOf(createApp())
  // A cold import of the whole app's module graph inside a hook; the default 20 s hook budget is for one step.
}, 60_000)

describe('maintenance-mode route classification', () => {
  it('walks the app-level routes, every feature router, Google and the let-through mounts', () => {
    const walked = live.entries.map((entry) => `${entry.method} ${entry.path}`)

    expect(walked).toEqual(
      expect.arrayContaining([
        'GET /health',
        'GET /api/v1/auth/google/callback',
        'POST /api/v1/tenants/:slug/flags/exposures',
        'GET /api/v1/status/maintenance',
        '* /api/v1/platform',
        '* /api/v1/webhooks/email',
        '* /api/v1/collect',
      ])
    )
  })

  it('classifies every route', () => {
    expect(unclassified(live.entries)).toEqual([])
  })

  it('has no rule for a route that no longer exists', () => {
    expect(staleRules(live.entries)).toEqual([])
  })

  it('lets exactly spec §4.3’s set through in full', () => {
    const open = MAINTENANCE_ROUTE_RULES.filter((rule) => rule.full === 'allow')
      .map((rule) => `${rule.method} ${rule.path}`)
      .toSorted(byText)

    expect(open).toEqual(
      [
        'GET /health',
        'GET /health/ready',
        '* /api/v1/webhooks/email',
        '* /api/v1/collect',
        'GET /api/v1/status/maintenance',
        '* /api/v1/platform',
        'POST /api/v1/auth/login',
        'GET /api/v1/auth/google',
        'GET /api/v1/auth/google/callback',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/reauthenticate',
        'GET /api/v1/auth/providers',
        'GET /api/v1/profile',
      ].toSorted(byText)
    )
  })

  it('lets exactly the flag exposure writes through in read_only beyond that set', () => {
    const writes = MAINTENANCE_ROUTE_RULES.filter(
      (rule) =>
        rule.method !== 'GET' &&
        rule.method !== '*' &&
        rule.readOnly === 'allow' &&
        rule.full === 'block'
    ).map((rule) => `${rule.method} ${rule.path}`)

    expect(writes.toSorted(byText)).toEqual(
      ['POST /api/v1/flags/exposures', 'POST /api/v1/tenants/:slug/flags/exposures'].toSorted(
        byText
      )
    )
  })

  it('lets every read through in read_only', () => {
    const blockedReads = live.entries
      .filter((entry) => entry.method === 'GET' && ruleFor(entry)?.readOnly !== 'allow')
      .map((entry) => entry.path)

    expect(blockedReads).toEqual([])
  })

  it('puts every staff-pass route behind requireAuth, which runs the staff check', () => {
    const unguarded = live.entries
      .filter((entry) => ruleFor(entry)?.staffPass === true && !entry.isBehindAuth)
      .map((entry) => `${entry.method} ${entry.path}`)

    expect(live.entries.filter((entry) => ruleFor(entry)?.staffPass === true)).toHaveLength(
      MAINTENANCE_STAFF_ROUTES.length
    )
    expect(unguarded).toEqual([])
  })

  it('passes staff on exactly the customer routes apex calls that it is not let through on already', () => {
    const fixture = JSON.parse(
      readFileSync(path.resolve('tests/fixtures/apex-api-calls.json'), 'utf8')
    ) as { calls: string[] }
    const needsStaffPass = fixture.calls.filter((call) => {
      const [method = '', callPath = ''] = call.split(' ', 2)
      return (
        !PRE_SIGN_IN_CALLS.has(call) && classifyMaintenanceRoute(method, callPath)?.full !== 'allow'
      )
    })

    expect(MAINTENANCE_STAFF_ROUTES.map((call) => shapeOf(call)).toSorted(byText)).toEqual(
      needsStaffPass.map((call) => shapeOf(call)).toSorted(byText)
    )
  })

  it('reports a staff-pass route that lost requireAuth', () => {
    const app = express()
    const api = Router()
    const tenants = Router()
    tenants.patch('/:slug', noop)
    api.use('/tenants', tenants)
    app.use('/api/v1', api)

    const [entry] = entriesOf(app)

    expect(entry).toMatchObject({ method: 'PATCH', path: '/api/v1/tenants/:slug' })
    expect(entry?.isBehindAuth).toBe(false)
    expect(entry && ruleFor(entry)?.staffPass).toBe(true)
  })

  it('fails on a route added without a classification', () => {
    const app = express()
    const api = Router()
    const tenants = Router()
    tenants.get('/:slug', noop)
    tenants.post('/:slug/archive-everything', noop)
    api.use('/tenants', tenants)
    app.use('/api/v1', api)

    expect(unclassified(entriesOf(app))).toEqual(['POST /api/v1/tenants/:slug/archive-everything'])
  })

  it('fails on a literal route that only matches a parameterised rule’s pattern', () => {
    const app = express()
    const api = Router()
    const tenants = Router()
    tenants.patch('/:slug/members/:userId', noop)
    tenants.patch('/:slug/members/bulk', noop)
    api.use('/tenants', tenants)
    app.use('/api/v1', api)

    expect(unclassified(entriesOf(app))).toEqual(['PATCH /api/v1/tenants/:slug/members/bulk'])
  })

  it('classifies every walked route by its own rule, not an earlier rule that matches its pattern', () => {
    expect(shadowed(live.entries, MAINTENANCE_ROUTE_RULES)).toEqual([])
  })

  it('fails on a literal rule placed after a parameterised rule that also matches it', () => {
    const app = express()
    const api = Router()
    const tenants = Router()
    tenants.patch('/:slug/members/:userId', noop)
    tenants.patch('/:slug/members/bulk', noop)
    api.use('/tenants', tenants)
    app.use('/api/v1', api)
    const literal: MaintenanceRouteRule = {
      method: 'PATCH',
      path: '/api/v1/tenants/:slug/members/bulk',
      match: 'exact',
      readOnly: 'block',
      full: 'block',
      staffPass: false,
    }
    const rules = [...MAINTENANCE_ROUTE_RULES, literal]

    expect(unclassified(entriesOf(app))).toEqual(['PATCH /api/v1/tenants/:slug/members/bulk'])
    expect(shadowed(entriesOf(app), rules)).toEqual(['PATCH /api/v1/tenants/:slug/members/bulk'])
  })

  it('fails on a rule whose route is gone', () => {
    const app = express()
    const api = Router()
    api.get('/flags', noop)
    app.use('/api/v1', api)

    expect(staleRules(entriesOf(app))).toContain('POST /api/v1/flags/exposures')
  })

  it('throws on a router mounted at an unknown path', () => {
    const app = express()
    app.use('/api/v1', Router().use('/hidden', Router()))

    expect(() => entriesOf(app)).toThrow('mounted at an unknown path')
  })
})
