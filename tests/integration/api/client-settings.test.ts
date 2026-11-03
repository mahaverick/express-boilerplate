/**
 * @file GET /api/v1/status/client-settings: public, cacheable for five
 * minutes, behind its own per-IP limiter, and answered in every maintenance
 * mode. The values come from the environment, mocked through `getEnv` with
 * non-default lifetimes and address, so the test passes only when the route
 * reads them.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { request } from '../../helpers/request'
import { clearRateLimiter } from '../../helpers/sign-in'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      SIGN_IN_LINK_TTL: '20m',
      STEP_UP_LINK_TTL: '25m',
      INVITATION_TTL: '5d',
      SUPPORT_EMAIL: 'support@test.example',
      ...minimumVersions,
    }),
  }
})

const minimumVersions: { MINIMUM_APP_VERSION_IOS?: string; MINIMUM_APP_VERSION_ANDROID?: string } =
  vi.hoisted(() => ({}))

const app = createApp()

beforeEach(async () => {
  // Other files in this worker share the IP; start the per-IP budget afresh.
  await clearRateLimiter(RATE_LIMITS.clientSettings.name)
})

afterAll(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

describe('GET /api/v1/status/client-settings', () => {
  it('answers the configured lifetimes and support address without a sign-in', async () => {
    const response = await request(app).get('/api/v1/status/client-settings')

    expect(response.status).toBe(200)
    expect(response.get('Cache-Control')).toBe('public, max-age=300')
    expect(response.get('RateLimit-Policy')).toBeDefined()
    expect(response.body).toMatchObject({
      success: true,
      message: 'Client settings retrieved.',
      data: {
        signInLinkTtlSeconds: 1200,
        stepUpLinkTtlSeconds: 1500,
        invitationTtlSeconds: 432_000,
        supportEmail: 'support@test.example',
      },
    })
  })

  it('answers null minimum app versions when none is set', async () => {
    const response = await request(app).get('/api/v1/status/client-settings')

    expect(response.body).toMatchObject({
      data: { minimumAppVersion: { ios: null, android: null } },
    })
  })

  it('answers the minimum app versions when set, still cacheable for five minutes', async () => {
    minimumVersions.MINIMUM_APP_VERSION_IOS = '1.4.0'
    minimumVersions.MINIMUM_APP_VERSION_ANDROID = '1.5.2'
    try {
      const response = await request(app).get('/api/v1/status/client-settings')

      expect(response.get('Cache-Control')).toBe('public, max-age=300')
      expect(response.body).toMatchObject({
        data: { minimumAppVersion: { ios: '1.4.0', android: '1.5.2' } },
      })
    } finally {
      delete minimumVersions.MINIMUM_APP_VERSION_IOS
      delete minimumVersions.MINIMUM_APP_VERSION_ANDROID
    }
  })

  it('answers during full maintenance, so a signed-out page can still read it', async () => {
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    // The mode took effect: a route outside the let-through list is refused.
    const refused = await request(app).get('/api/v1/tenants')
    expect(refused.status).toBe(503)
    const response = await request(app).get('/api/v1/status/client-settings')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { supportEmail: 'support@test.example' } })
  })
})
