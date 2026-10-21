/**
 * @file Every password route under `/api/v1/auth` is gone: each answers
 * exactly what an unknown auth path answers, status and body, so no client
 * can tell a removed route from one that never existed.
 */
import type { Response } from 'supertest'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * The paths that signed in, registered, verified or reset by password.
 */
const REMOVED_PATHS = [
  'register',
  'login',
  'verify-email',
  'resend-verification',
  'forgot-password',
  'reset-password',
  'change-password',
] as const

/**
 * A response body without its per-request id, which differs on every call.
 * @param response - The supertest response.
 * @returns The body, `requestId` removed.
 */
function bodyWithoutRequestId(response: Response): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(response.body as Record<string, unknown>) }
  delete copy.requestId
  return copy
}

describe('removed password routes', () => {
  it.each(REMOVED_PATHS)('answers POST /auth/%s as an unknown auth path', async (path) => {
    const body = { email: 'removed-route@example.test', password: 'not-a-password-route' }
    const unknown = await request(app).post('/api/v1/auth/not-a-route').send(body)

    const response = await request(app).post(`/api/v1/auth/${path}`).send(body)

    expect(unknown.status).toBe(404)
    expect(response.status).toBe(unknown.status)
    expect(bodyWithoutRequestId(response)).toEqual(bodyWithoutRequestId(unknown))
  })
})
