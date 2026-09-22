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

    // `cors` answers the preflight but withholds the grant header, which is
    // what makes the browser block it. Asserting the HEADER is absent is the
    // real check — asserting a status code here proves nothing.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('leaves same-origin requests, which send no Origin, completely alone', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
