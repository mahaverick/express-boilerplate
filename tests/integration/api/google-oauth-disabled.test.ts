/**
 * @file The opposite env state from google-oauth.test.ts: no Google
 * credentials at all (this repo's actual .env.test default), left
 * untouched here. See the describe block below for why this cannot be
 * a second describe in that file instead, and why it depends on that
 * file's own env cleanup.
 */

import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * Could not be a second `describe` block in google-oauth.test.ts
 * instead: `getEnv()` memoises the first environment it parses for
 * this worker process's whole lifetime, so once GOOGLE_CLIENT_ID has
 * been set once, nothing short of `vi.resetModules()` (with its own
 * real cost — see tests/helpers/mutate.ts) could make a later test in
 * that file observe it unset again.
 *
 * Depends on google-oauth.test.ts cleaning up after itself:
 * `process.env` persists across test files within one forked worker
 * process, so this file's "unset" premise only holds because that file
 * stubs GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET with `vi.stubEnv` and
 * restores them in `afterAll(() => vi.unstubAllEnvs())` rather than
 * leaving a raw `process.env` assignment behind. If that file is ever
 * changed to mutate `process.env` directly again, this file can start
 * failing (or silently stop testing what it claims to) purely from run
 * order.
 */
describe('GET /api/v1/auth/google (Google OAuth not configured)', () => {
  it('answers 404 — the route is never mounted without GOOGLE_CLIENT_ID', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    expect(response.status).toBe(404)
  })
})
