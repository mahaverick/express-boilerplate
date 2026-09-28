/**
 * @file Health-probe behaviour: shallow vs. deep checks, request-id
 * stamping and the error envelope for unmatched routes.
 */

import express from 'express'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { HttpError } from '@/errors/http-error'
import { errorHandler } from '@/middlewares/error.middleware'
import { request } from '../../helpers/request'

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
    expect(response.body).toHaveProperty('checks.queue')
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
    // Built bare, not via createApp(): its 404 catch-all is already mounted and would match first, making the test pass for the wrong reason.
    const probe = express()
    // Express 5 forwards a rejected handler's promise to the error handler itself; express-async-handler is not installed.
    probe.get('/boom', () => Promise.reject(new HttpError('deliberate', 418)))
    probe.use(errorHandler)
    const response = await request(probe).get('/boom')
    expect(response.status).toBe(418)
  })
})
