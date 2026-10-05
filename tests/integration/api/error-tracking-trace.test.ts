/**
 * @file A reported 5xx under the real HTTP and Express instrumentations, in
 * an SDK this file starts before Express loads
 * (`tests/helpers/trace-capture.ts`): the span records the exception with
 * its scrubbed message only and is marked an error, the `$exception`
 * carries the request's trace id, and the route template survives the
 * Express instrumentation's own routing patches. Error tracking is enabled
 * through a mocked `getEnv()` against a fake PostHog.
 */
import { SpanStatusCode } from '@opentelemetry/api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const capture = await vi.hoisted(async () => {
  const { HTTP_INSTRUMENTATION_CONFIG } = await import('@/observability/tracing')
  const { startTraceCapture } = await import('../../helpers/trace-capture')
  return startTraceCapture(HTTP_INSTRUMENTATION_CONFIG)
})

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
      ERROR_TRACKING_ENABLED: true,
    }),
  }
})

const { default: express } = await import('express')
const { errorHandler } = await import('@/middlewares/error.middleware')
const { requestContext } = await import('@/middlewares/request-context.middleware')
const { requestId } = await import('@/middlewares/request-id.middleware')
const { recordRouteTemplate } = await import('@/middlewares/route-template.middleware')
const { flushErrorReports } = await import('@/services/errors/error-reporter.service')
const { logger } = await import('@/services/logger.service')
const { startFakePosthog } = await import('../../helpers/fake-posthog')
const { request } = await import('../../helpers/request')

type FakePosthog = Awaited<ReturnType<typeof startFakePosthog>>
const fake: { posthog?: FakePosthog } = {}

/**
 * An app whose one route throws a message carrying an address.
 * @returns The app.
 */
function probeApp(): ReturnType<typeof express> {
  const app = express()
  app.use(requestId)
  app.use(recordRouteTemplate)
  app.use(requestContext)
  const router = express.Router()
  router.get('/orders/:orderId', () => {
    throw new Error('lookup failed for traced-leak@example.test')
  })
  app.use('/api/traced', router)
  app.use(errorHandler)
  return app
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

afterAll(async () => {
  await fake.posthog?.close()
  await capture.stop()
})

describe('a reported 5xx under tracing', () => {
  it('records the scrubbed exception on the span, marks it an error and links the event to the trace', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    capture.exporter.reset()

    const response = await request(probeApp()).get('/api/traced/orders/42')
    await flushErrorReports(5000)

    expect(response.status).toBe(500)
    const spans = capture.exporter.getFinishedSpans()
    const recorded = spans.filter((span) => span.events.some((event) => event.name === 'exception'))
    expect(recorded).toHaveLength(1)
    const [span] = recorded
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(JSON.stringify(span?.events)).not.toContain('traced-leak@example.test')
    const event = fake.posthog?.batches.flat().find((sent) => sent.event === '$exception')
    expect(event?.properties).toMatchObject({
      trace_id: span?.spanContext().traceId,
      http_route: '/api/traced/orders/:orderId',
    })
  })
})
