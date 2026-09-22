import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'

const app = createApp()

describe('CORS', () => {
  it('answers a preflight from an allowed origin with credentials enabled', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    // Echoed, never '*': the CORS spec forbids a wildcard with credentials,
    // and browsers reject the response outright if both appear.
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('allows Last-Event-ID, without which SSE replay silently never fires', async () => {
    const response = await request(app)
      .options('/api/v1/notifications/stream')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,last-event-id')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'last-event-id'
    )
  })

  it('does not grant access to an origin that is not allowed', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')

    // `cors` withholds the grant header for a disallowed origin, but unlike
    // an allowed one it does NOT end the request here — it calls `next()`
    // and the preflight falls through into the rest of the stack (see
    // cors.config.ts and app.ts's mount-order comment). For this route that
    // lands on Express's own built-in OPTIONS responder — `/login` only
    // registers POST, so Express answers 200 with `Allow: POST` — measured
    // directly against this app, not assumed. The absence of the grant
    // header is what actually blocks the browser, so that assertion is the
    // real check; the status is pinned too, specifically so this test fails
    // loudly (instead of passing unchanged either way) if a future change
    // adds a short-circuit here or `cors`'s fall-through behaviour changes.
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('leaves same-origin requests, which send no Origin, completely alone', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
