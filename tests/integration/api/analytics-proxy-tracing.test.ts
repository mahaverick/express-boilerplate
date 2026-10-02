/**
 * @file The proxy makes no trace, through the real HTTP and Express
 * instrumentations configured with tracing.ts's own
 * `HTTP_INSTRUMENTATION_CONFIG`, in an SDK this file starts before Express
 * loads (`tests/helpers/trace-capture.ts`): a request under
 * `/api/v1/collect/` records no server or Express span, while an API
 * request does. Client spans are supertest's own outgoing requests.
 */
import { SpanKind } from '@opentelemetry/api'
import { afterAll, describe, expect, it, vi } from 'vitest'

const capture = await vi.hoisted(async () => {
  const { HTTP_INSTRUMENTATION_CONFIG } = await import('@/observability/tracing')
  const { startTraceCapture } = await import('../../helpers/trace-capture')
  return startTraceCapture(HTTP_INSTRUMENTATION_CONFIG)
})

const { createApp } = await import('@/app')
const { request } = await import('../../helpers/request')

const app = createApp()

/**
 * The finished spans the server side produced.
 * @returns Each span's name.
 */
function serverSpanNames(): string[] {
  return capture.exporter
    .getFinishedSpans()
    .filter((span) => span.kind !== SpanKind.CLIENT)
    .map((span) => span.name)
}

afterAll(async () => {
  await capture.stop()
})

describe('tracing the analytics proxy', () => {
  it('records no server span for a request under /api/v1/collect/, and some for an API request', async () => {
    capture.exporter.reset()
    await request(app).post('/api/v1/collect/e/?ver=1').send('x')
    expect(serverSpanNames()).toEqual([])

    await request(app).get('/api/v1/no-such-route')
    expect(serverSpanNames()).toContain('GET')
  })
})
