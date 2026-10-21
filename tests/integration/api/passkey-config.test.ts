/**
 * @file GET /api/v1/auth/passkeys/config: public, `no-store`, and answered in
 * every mode so the apps can hide the passkey UI. In `off` mode a route behind
 * `requirePasskeysEnabled` answers exactly the unknown-route 404. The mode is
 * mocked through `getEnv`, never through `process.env`.
 */
import express from 'express'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv, type Env } from '@/configs/env.config'
import { withMutatedModule } from '../../helpers/mutate'
import { request } from '../../helpers/request'

/**
 * The envelope fields the unknown-route comparison drops, since they differ per request.
 */
const PER_REQUEST_FIELDS = ['requestId', 'timestamp']

/**
 * A body without its per-request fields.
 * @param body - The parsed response body.
 * @returns The stable part.
 */
function stable(body: unknown): Record<string, unknown> {
  const copy = { ...(body as Record<string, unknown>) }
  for (const field of PER_REQUEST_FIELDS) delete copy[field]
  return copy
}

describe('GET /api/v1/auth/passkeys/config', () => {
  it('answers the mode and RP ID without a sign-in, uncached', async () => {
    const response = await request(createApp()).get('/api/v1/auth/passkeys/config')

    expect(response.status).toBe(200)
    expect(response.get('Cache-Control')).toBe('no-store')
    expect(response.body).toMatchObject({
      success: true,
      message: 'Passkey settings retrieved.',
      data: { mode: 'optional', rpId: 'localhost' },
    })
  })

  it('answers mode off, and a gated route answers the unknown-route 404', async () => {
    const real = getEnv()
    const off: Env = { ...real, PASSKEY_MODE: 'off' }
    await withMutatedModule<
      { getEnv: () => Env },
      [
        typeof import('@/app'),
        typeof import('@/middlewares/passkey.middleware'),
        typeof import('@/middlewares/error.middleware'),
      ]
    >(
      '@/configs/env.config',
      { getEnv: () => off },
      async () => {
        // One at a time: in a Promise.all load, passkey.config read the real mode while env.config answered off (probed); sequential loads agree.
        const middleware = await import('@/middlewares/passkey.middleware')
        const errors = await import('@/middlewares/error.middleware')
        const appModule = await import('@/app')
        return [appModule, middleware, errors] as const
      },
      async ([{ createApp: createOffApp }, { requirePasskeysEnabled }, { errorHandler }]) => {
        const app = createOffApp()
        const config = await request(app).get('/api/v1/auth/passkeys/config')
        expect(config.status).toBe(200)
        expect(config.body).toMatchObject({ data: { mode: 'off', rpId: 'localhost' } })

        // Test-only probe: no fake route lives in src/.
        const probe = express()
        probe.get('/probe', requirePasskeysEnabled, (_request, response) => {
          response.json({ reached: true })
        })
        probe.use(errorHandler)
        const gated = await request(probe).get('/probe')
        const unknown = await request(app).get('/api/v1/nope')

        expect(gated.status).toBe(404)
        expect(stable(gated.body)).toEqual(stable(unknown.body))
      }
    )
  })
})
