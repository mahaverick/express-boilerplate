/**
 * @file `/api/v1/collect/*` through the real app to the fake PostHog, which
 * plays both the ingest and the assets host (`POSTHOG_ASSETS_HOST`). Covers
 * the routing (sub-paths, query strings, the assets prefixes), the mount
 * order (bodies express.json or express.urlencoded would refuse or consume
 * arrive byte for byte), what the upstream sees of the client (its
 * User-Agent and resolved address, never its cookies or bearer token), the
 * proxy's own limiter, and an unreachable upstream. Analytics is enabled for
 * this file through a mocked `getEnv()`.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Express } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { logger } from '@/services/logger.service'
import { startFakePosthog, type FakePosthog } from '../../helpers/fake-posthog'
import { request } from '../../helpers/request'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
      POSTHOG_ASSETS_HOST: target.host,
    }),
  }
})

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const state: { posthog?: FakePosthog; app?: Express } = {}

/**
 * The running fake and the app proxying to it.
 * @returns Both.
 */
function running(): { posthog: FakePosthog; app: Express } {
  if (!state.posthog || !state.app) throw new Error('setup did not run')
  return { posthog: state.posthog, app: state.app }
}

/**
 * A SHA-256 digest, to compare large bodies without printing them.
 * @param bytes - The bytes.
 * @returns The hex digest.
 */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  state.app = createApp()
})

afterEach(() => {
  const { posthog } = running()
  posthog.requests.length = 0
  posthog.batches.length = 0
  posthog.respondWith(200)
})

afterAll(async () => {
  await state.posthog?.close()
})

describe('routing', () => {
  it.each([
    ['/api/v1/collect/e/?ip=1&ver=1.435.6', '/e/?ip=1&ver=1.435.6'],
    ['/api/v1/collect/i/v0/e/?compression=gzip-js', '/i/v0/e/?compression=gzip-js'],
    ['/api/v1/collect/s/?compression=gzip-js', '/s/?compression=gzip-js'],
    ['/api/v1/collect/flags/?v=2', '/flags/?v=2'],
  ])('sends POST %s to the ingest host as %s', async (path, upstreamPath) => {
    const { app, posthog } = running()

    const response = await request(app).post(path).set('content-type', 'text/plain').send('x=1')

    expect(response.status).toBe(200)
    expect(posthog.requests.map((received) => [received.method, received.path])).toEqual([
      ['POST', upstreamPath],
    ])
  })

  it.each([
    ['/api/v1/collect/static/recorder.js?v=1.435.6', '/static/recorder.js?v=1.435.6'],
    [
      '/api/v1/collect/array/phc_test_key_not_real/config.js',
      '/array/phc_test_key_not_real/config.js',
    ],
  ])('sends GET %s to the assets host as %s', async (path, upstreamPath) => {
    const { app, posthog } = running()

    const response = await request(app).get(path)

    expect(response.status).toBe(200)
    expect(posthog.requests.map((received) => received.path)).toEqual([upstreamPath])
  })

  it('passes the upstream status through', async () => {
    const { app, posthog } = running()
    posthog.respondWith(400)

    const response = await request(app).post('/api/v1/collect/e/').send('x')

    expect(response.status).toBe(400)
  })
})

describe('bodies stream through unread, ahead of the body parsers', () => {
  it('delivers a 5 MB binary body byte for byte', async () => {
    const { app, posthog } = running()
    const body = randomBytes(5 * 1024 * 1024)

    const response = await request(app)
      .post('/api/v1/collect/s/?compression=gzip-js')
      .set('content-type', 'text/plain')
      .send(body)

    expect(response.status).toBe(200)
    const [received] = posthog.requests
    expect(received?.body.length).toBe(body.length)
    expect(sha256(received?.body ?? Buffer.alloc(0))).toBe(sha256(body))
  }, 20_000)

  it('delivers a JSON body over express.json’s 1mb limit unchanged: the proxy runs before it', async () => {
    const { app, posthog } = running()
    // Whitespace and key order a JSON round-trip would not reproduce.
    const body = Buffer.from(`{ "batch" : [ "${'a'.repeat(1_500_000)}" ] ,"z":1 }`)

    const response = await request(app)
      .post('/api/v1/collect/e/')
      .set('content-type', 'application/json')
      .send(body.toString('utf8'))

    expect(response.status).toBe(200)
    expect(sha256(posthog.requests[0]?.body ?? Buffer.alloc(0))).toBe(sha256(body))
  })

  it('delivers a urlencoded body over express.urlencoded’s 100kb limit unchanged', async () => {
    const { app, posthog } = running()
    const body = `data=${'b'.repeat(200_000)}&compression=base64`

    const response = await request(app)
      .post('/api/v1/collect/e/')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send(body)

    expect(response.status).toBe(200)
    expect(posthog.requests[0]?.body.toString('utf8')).toBe(body)
  })
})

describe('what PostHog sees of the client', () => {
  it('keeps the real User-Agent and sets the upstream Host', async () => {
    const { app, posthog } = running()

    await request(app).post('/api/v1/collect/e/').set('user-agent', BROWSER_USER_AGENT).send('x')

    const [received] = posthog.requests
    expect(received?.headers['user-agent']).toBe(BROWSER_USER_AGENT)
    expect(received?.headers.host).toBe(new URL(posthog.url).host)
  })

  it('names the client by the address Express resolved, not by a header the client sent', async () => {
    const { app, posthog } = running()

    // TRUST_PROXY is false in the suite, so the socket address is the client's.
    await request(app).post('/api/v1/collect/e/').set('x-forwarded-for', '203.0.113.7').send('x')

    expect(posthog.requests[0]?.headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(posthog.requests[0]?.headers['x-forwarded-proto']).toBe('http')
  })

  it('never forwards the browser’s cookies or bearer token', async () => {
    const { app, posthog } = running()

    await request(app)
      .post('/api/v1/collect/e/')
      .set('cookie', '__Host-refreshToken=not-a-real-token; other=1')
      .set('authorization', 'Bearer not-a-real-token')
      .send('x')

    const [received] = posthog.requests
    expect(received?.headers.cookie).toBeUndefined()
    expect(received?.headers.authorization).toBeUndefined()
  })
})

describe('the proxy’s limiter', () => {
  it('is its own, analytics-proxy, mounted at /api/v1/collect ahead of the proxy', () => {
    const { app } = running()
    const withRouter = app as unknown as {
      router: { stack: { name: string; handle: object; matchers?: unknown }[] }
    }
    const marks = withRouter.router.stack.map(
      (layer) => (layer.handle as Record<symbol, unknown>)[RATE_LIMITER_MARK]
    )
    expect(marks.filter((mark) => mark !== undefined)).toEqual([RATE_LIMITS.analyticsProxy.name])
  })

  it('answers with its own budget in the RateLimit headers', async () => {
    const { app } = running()

    const response = await request(app).post('/api/v1/collect/e/').send('x')

    expect(response.headers['ratelimit-limit']).toBe(String(RATE_LIMITS.analyticsProxy.limit))
  })
})

describe('an unreachable PostHog', () => {
  it('answers 504 at once and logs the failure at warn', async () => {
    const unreachable = await startFakePosthog()
    await unreachable.close()
    target.host = unreachable.url
    const app = createApp()
    const warn = vi.spyOn(logger, 'warn')

    try {
      const response = await request(app).post('/api/v1/collect/e/').send('x')

      expect(response.status).toBe(504)
      expect(warn).toHaveBeenCalledWith('Analytics proxy upstream failed', {
        error: expect.objectContaining({ code: 'ECONNREFUSED' }) as unknown,
      })
    } finally {
      warn.mockRestore()
      target.host = running().posthog.url
    }
  })
})
