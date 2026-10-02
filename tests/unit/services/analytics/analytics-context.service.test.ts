/**
 * @file currentAnalyticsContext reads OTel's global context manager, which
 * nothing registers in this suite (tracing.ts never starts here), so this
 * file registers a real AsyncLocalStorageContextManager, as
 * logger.service.test.ts does, and makes a span active with
 * `trace.wrapSpanContext`.
 */
import { context, INVALID_SPAN_CONTEXT, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import { requestContextStore } from '@/services/request-context.service'

const SPAN_CONTEXT = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: TraceFlags.SAMPLED,
}
const SESSION_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

/**
 * Run `read` with `spanContext` active.
 * @param spanContext - The span context to make active.
 * @param read - What to run inside it.
 * @returns What `read` returned.
 */
function withSpan<T>(spanContext: typeof SPAN_CONTEXT, read: () => T): T {
  return context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), read)
}

beforeAll(() => {
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(true)
})

afterAll(() => {
  context.disable()
})

describe('currentAnalyticsContext', () => {
  it('is empty outside any span or request', () => {
    expect(currentAnalyticsContext()).toEqual({})
  })

  it("copies the active span's trace and span ids", () => {
    expect(withSpan(SPAN_CONTEXT, currentAnalyticsContext)).toEqual({
      traceId: SPAN_CONTEXT.traceId,
      spanId: SPAN_CONTEXT.spanId,
    })
  })

  it('ignores an invalid span context', () => {
    expect(withSpan(INVALID_SPAN_CONTEXT, currentAnalyticsContext)).toEqual({})
  })

  it("copies the request's PostHog session id", () => {
    const read = (): ReturnType<typeof currentAnalyticsContext> =>
      requestContextStore.run({ requestId: 'req-1', posthogSessionId: SESSION_ID }, () =>
        withSpan(SPAN_CONTEXT, currentAnalyticsContext)
      )
    expect(read()).toEqual({
      traceId: SPAN_CONTEXT.traceId,
      spanId: SPAN_CONTEXT.spanId,
      posthogSessionId: SESSION_ID,
    })
  })

  it('omits the session id when the request carried none', () => {
    expect(requestContextStore.run({ requestId: 'req-2' }, currentAnalyticsContext)).toEqual({})
  })
})
