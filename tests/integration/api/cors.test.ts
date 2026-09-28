import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { request } from '../../helpers/request'

const app = createApp()

const allowedOrigin = process.env.WEB_URL ?? 'http://localhost:5173'

describe('CORS', () => {
  it('answers a preflight from an allowed origin with credentials enabled', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    // Pins the echoed origin exactly, not merely "not '*'", which would also pass with the header absent entirely.
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin)
  })

  it('allows Last-Event-ID, without which SSE replay silently never fires', async () => {
    const response = await request(app)
      .options('/api/v1/notifications/stream')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,last-event-id')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'last-event-id'
    )
  })

  it('grants PUT, not just the hand-picked verbs an earlier config listed', async () => {
    // cors.config.ts sets no `methods` list, so PUT reaches the grant only through `cors`'s own default method list.
    const response = await request(app)
      .options('/api/v1/notifications/preferences')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-methods']).toContain('PUT')
  })

  it('does not grant access to an origin that is not allowed', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')

    // `cors` withholds the grant header but calls next() rather than ending the request, so this falls through to Express's built-in OPTIONS responder (Allow: POST, since /login registers only POST); the missing grant header is what actually blocks the browser, and the status is pinned too so a future short-circuit here fails loudly instead of passing unchanged.
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('leaves same-origin requests, which send no Origin, completely alone', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
