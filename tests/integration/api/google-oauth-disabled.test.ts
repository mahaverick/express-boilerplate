/**
 * @file The opposite env state from google-oauth.test.ts: no Google
 * credentials at all, which is this repo's `.env.test` default and is left
 * untouched here.
 */

import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * Not a second `describe` in google-oauth.test.ts: `getEnv()` memoises the
 * first environment it parses for the life of a process, so once
 * GOOGLE_CLIENT_ID has been set there, nothing short of `vi.resetModules()`
 * (with its own cost, see tests/helpers/mutate.ts) would let a later test see
 * it unset. Vitest runs each test file in its own process, so this file
 * starts from the unmodified test env.
 */
describe('GET /api/v1/auth/google (Google OAuth not configured)', () => {
  it('answers 404 — the route is never mounted without GOOGLE_CLIENT_ID', async () => {
    const response = await request(app).get('/api/v1/auth/google')
    expect(response.status).toBe(404)
  })
})
