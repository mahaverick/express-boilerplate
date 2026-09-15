// tests/integration/api/health.test.ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'

const app = createApp()

describe('health probes', () => {
  it('GET /health is shallow and does not touch the database', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok' })
  })

  it('GET /health/ready reports each dependency', async () => {
    const response = await request(app).get('/health/ready')
    expect([200, 503]).toContain(response.status)
    expect(response.body).toHaveProperty('checks.database')
    expect(response.body).toHaveProperty('checks.redis')
  })

  it('stamps a request id on every response', async () => {
    const response = await request(app).get('/health')
    expect(response.get('X-Request-Id')).toMatch(/[\da-f-]{36}/)
  })

  it('echoes a caller-supplied request id', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const response = await request(app).get('/health').set('X-Request-Id', id)
    expect(response.get('X-Request-Id')).toBe(id)
  })

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(app).get('/api/v1/nope')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ success: false, statusCode: 404 })
  })

  it('forwards a rejected promise from an async handler without a wrapper', async () => {
    // Express 5 does this itself; express-async-handler is not installed.
    //
    // Built bare rather than from createApp(): Express matches in registration
    // order and createApp() has already mounted its 404 catch-all, so a route
    // added afterwards is unreachable — the test would assert 404 and pass for
    // entirely the wrong reason.
    const probe = express()
    probe.get('/boom', () => Promise.reject(new HttpError('deliberate', 418)))
    probe.use(errorHandler)
    const response = await request(probe).get('/boom')
    expect(response.status).toBe(418)
  })
})
