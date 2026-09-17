// tests/integration/api/google-oauth.test.ts
//
// Exercises the REAL `createOAuthSessionMiddleware()` against the real,
// per-worker Redis instance (REDIS_URL in .env.test) — not a mock. That is
// the whole point of this file existing under tests/integration/, not
// tests/unit/: the brief this task was built from flagged
// `new RedisStore({ client: getRedis() })` as something to "verify
// empirically" rather than assume, and the only way to actually verify it
// is to run a real request through a real connect-redis `RedisStore` backed
// by a real node-redis client and see whether the OAuth redirect (which
// needs `req.session` for the `state` CSRF parameter) actually works.
// passport.config.ts's own header comment explains why the naive version
// (handing `RedisStore` the un-awaited `Promise<RedisClientType>` the brief's
// own sketch used) does NOT work, and this file is what proves the lazy-latch
// replacement does.
//
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set in `beforeAll`, via a
// DYNAMIC `import('@/app')` — not a static `import` at the top of this
// file, and not merely "set before calling `createApp()`" the way a first
// draft of this file tried. Verified empirically, the hard way: a static
// `import { createApp } from '@/app'` at the top of the file, with
// `process.env.GOOGLE_CLIENT_ID` set inside `beforeAll` immediately before
// calling `createApp()`, still produced a 404 — because `@/app` transitively
// imports `database.service.ts`, which calls `const env = getEnv()` at ITS
// OWN module scope. A static import's entire dependency graph evaluates
// before ANY of THIS file's own top-level code runs (that is what "static"
// means for a module graph) — so `getEnv()` was already memoised, without
// `GOOGLE_CLIENT_ID`, before `beforeAll` (or anything else in this file)
// ever got a chance to run, regardless of where the `import` statement sat
// in the file or when `createApp()` was actually CALLED. A dynamic
// `import()` has no such hoisting: it evaluates exactly where it is
// awaited, so performing it inside `beforeAll`, after the `process.env`
// assignments, is what actually gets `GOOGLE_CLIENT_ID` into `getEnv()`'s
// first (and only) parse. They are never real Google credentials —
// passport's Google strategy builds the redirect URL locally from
// `clientID`/`scope`/`callbackURL`; nothing in this test ever calls Google.
//
// A SEPARATE file, google-oauth-disabled.test.ts, covers the opposite env
// state (no Google credentials at all — this repo's actual .env.test
// default). That cannot live in this file: `getEnv()` memoises the first
// environment it parses for the life of this worker process, so once
// `createApp()` below has run with GOOGLE_CLIENT_ID set, no later test in
// this same file could ever observe it unset without `vi.resetModules()` —
// which discards this whole worker's module cache, including
// database.service.ts's live postgres pool (tests/helpers/mutate.ts's own
// header comment on `withMutatedModule` explains the leak). Two small,
// cheap files avoid paying that cost for a distinction this simple.
//
// `vi.stubEnv`, not a raw `process.env.GOOGLE_CLIENT_ID = ...` assignment —
// `tests/helpers/worker-database.ts`'s own header comment establishes that
// `process.env` persists ACROSS test files within one forked worker
// process (only the module registry resets between files, per
// tests/helpers/setup-global.ts). A raw assignment here would leak
// `GOOGLE_CLIENT_ID` into whichever file vitest schedules next in this
// worker — including google-oauth-disabled.test.ts, whose entire premise is
// that variable being unset. `afterAll(() => vi.unstubAllEnvs())` restores
// the prior value (here, genuinely absent, since `.env.test` never sets it)
// rather than merely deleting the key, so this file leaves no trace on
// `process.env` for whatever runs after it in the same worker.
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'

/**
 * The `state` query parameter off a Google OAuth redirect URL, if present.
 * Module-scoped rather than declared inside a test — a closure with no
 * reference to anything in its enclosing test's scope has no reason to be
 * redeclared on every run.
 * @param location - The `Location` header from a `GET /auth/google` response.
 * @returns The `state` value, or undefined when absent.
 */
function stateOf(location: string | undefined): string | undefined {
  return location ? (new URL(location).searchParams.get('state') ?? undefined) : undefined
}

describe('GET /api/v1/auth/google (Google OAuth configured)', () => {
  let app: ReturnType<typeof CreateApp>

  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
    const { createApp } = await import('@/app')
    app = createApp()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('responds with a 302 redirect', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    expect(response.status).toBe(302)
  })

  it('redirects to Google, carrying client_id, redirect_uri, scope, and state', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    const location = response.headers.location
    expect(location).toBeDefined()
    expect(location).toContain('https://accounts.google.com')
    expect(location).toContain('client_id=test-google-client-id')
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent('http://localhost:4040/api/v1/auth/google/callback')}`
    )
    expect(location).toContain('scope=')
    expect(location).toContain('state=')
  })

  it('sets the OAuth session cookie needed to verify `state` on the callback', async () => {
    // `resave: false, saveUninitialized: false` (createOAuthSessionMiddleware)
    // still issues a cookie here: the Google strategy's `state: true` writes
    // to `req.session` on this very request (to store the CSRF state value),
    // which is exactly the kind of write saveUninitialized's own semantics
    // do not suppress — only a session left completely untouched is skipped.
    const response = await request(app).get('/api/v1/auth/google')
    const cookies = response.headers['set-cookie'] as string[] | undefined
    expect(cookies).toBeDefined()
    expect(cookies?.some((cookie) => cookie.startsWith('oauth.sid='))).toBe(true)
  })

  it('issues a fresh state value on every request (not a fixed or replayed one)', async () => {
    const first = await request(app).get('/api/v1/auth/google')
    const second = await request(app).get('/api/v1/auth/google')

    const firstState = stateOf(first.headers.location)
    const secondState = stateOf(second.headers.location)
    expect(firstState).toBeTruthy()
    expect(secondState).toBeTruthy()
    expect(firstState).not.toBe(secondState)
  })
})
