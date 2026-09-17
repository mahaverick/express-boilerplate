// tests/integration/api/google-oauth-disabled.test.ts
//
// The opposite env state from google-oauth.test.ts: NO Google credentials
// at all — this repo's actual .env.test default, deliberately left
// untouched here (no `process.env` override, no `vi.stubEnv`). See
// google-oauth.test.ts's own header comment for why this could not be a
// second `describe` block in that file instead: `getEnv()` memoises the
// first environment it parses for this worker process's whole lifetime, so
// once GOOGLE_CLIENT_ID has been set once, nothing short of
// `vi.resetModules()` (with its own real cost — see tests/helpers/mutate.ts)
// could make a later test in that file observe it unset again.
//
// DEPENDS on google-oauth.test.ts cleaning up after itself: `process.env`
// persists across test files within one forked worker process
// (tests/helpers/worker-database.ts's own header comment), so this file's
// "unset" premise only holds because that file stubs GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET with `vi.stubEnv` and restores them in
// `afterAll(() => vi.unstubAllEnvs())` rather than leaving a raw
// `process.env` assignment behind. If that file is ever changed to mutate
// `process.env` directly again, this file can start failing (or silently
// stop testing what it claims to) purely from run order.
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'

const app = createApp()

describe('GET /api/v1/auth/google (Google OAuth not configured)', () => {
  it('answers 404 — the route is never mounted without GOOGLE_CLIENT_ID', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    expect(response.status).toBe(404)
  })
})
