/**
 * @file The trace and browser session a server analytics event belongs to,
 * read at build time from the active OTel span and the request context.
 */
import { isSpanContextValid, trace } from '@opentelemetry/api'
import { requestContextStore } from '@/services/request-context.service'
import type { AnalyticsContext } from '@/types/analytics'

/**
 * The current analytics context: the active span's trace and span ids when
 * its context is valid, the request's PostHog session id when the browser
 * sent one, and the request's authenticated user id. Outside a request and a span, it is empty.
 * @returns The context; absent fields are omitted, never undefined.
 */
export function currentAnalyticsContext(): AnalyticsContext {
  const context: AnalyticsContext = {}
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (spanContext && isSpanContextValid(spanContext)) {
    context.traceId = spanContext.traceId
    context.spanId = spanContext.spanId
  }
  const store = requestContextStore.getStore()
  if (store?.posthogSessionId !== undefined) context.posthogSessionId = store.posthogSessionId
  if (store?.userId !== undefined) context.userId = store.userId
  return context
}
