/**
 * @file `/api/v1/collect/*` with analytics unconfigured, the suite's default
 * (`.env.test` sets no `POSTHOG_PROJECT_KEY`): every method and path answers
 * 503 in the error envelope, and nothing is proxied anywhere.
 */
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { request } from '../../helpers/request'

const app = createApp()

describe('the analytics proxy while analytics is not configured', () => {
  it.each([
    ['get', '/api/v1/collect/static/recorder.js'],
    ['post', '/api/v1/collect/e/?ver=1'],
    ['post', '/api/v1/collect/s/'],
    ['put', '/api/v1/collect/anything'],
  ] as const)('answers %s %s with 503 service_unavailable', async (method, path) => {
    const response = await request(app)[method](path).send('x')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      success: false,
      message: 'Analytics is not configured',
      statusCode: 503,
      code: 'service_unavailable',
      requestId: response.headers['x-request-id'],
    })
  })
})
