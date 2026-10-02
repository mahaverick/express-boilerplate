/**
 * @file An in-process OpenTelemetry SDK for one test file, with the HTTP and
 * Express instrumentations and an in-memory exporter, so a test can read the
 * spans a request produced and the trace ids the server saw. The suite runs
 * without `OTEL_EXPORTER_OTLP_ENDPOINT`, so `tracing.ts` starts nothing;
 * call `startTraceCapture` from `vi.hoisted`, before the file imports
 * Express, and `stop()` in `afterAll`, which also unregisters the global
 * tracer, context manager and propagator so the next file in the worker
 * runs untraced.
 */
import { createRequire } from 'node:module'
import { context, propagation, trace } from '@opentelemetry/api'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import {
  HttpInstrumentation,
  type HttpInstrumentationConfig,
} from '@opentelemetry/instrumentation-http'
import { NodeSDK, tracing } from '@opentelemetry/sdk-node'

/**
 * A running capture.
 */
export interface TraceCapture {
  /**
   * Holds every finished span.
   */
  exporter: tracing.InMemorySpanExporter
  /**
   * Shut the SDK down and unregister every global it set.
   */
  stop: () => Promise<void>
}

/**
 * Start the SDK: W3C trace context, an AsyncLocalStorage context manager, and
 * the HTTP and Express instrumentations.
 * @param httpConfig - The HTTP instrumentation's configuration, normally
 *   tracing.ts's `HTTP_INSTRUMENTATION_CONFIG`.
 * @returns The capture.
 */
export function startTraceCapture(httpConfig: HttpInstrumentationConfig = {}): TraceCapture {
  const exporter = new tracing.InMemorySpanExporter()
  const sdk = new NodeSDK({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    instrumentations: [],
  })
  sdk.start()
  const unregister = registerInstrumentations({
    instrumentations: [new HttpInstrumentation(httpConfig), new ExpressInstrumentation()],
  })
  // An earlier file in this worker may have loaded node:http already; requiring it again runs the patch hook.
  createRequire(import.meta.url)('node:http')
  return {
    exporter,
    stop: async () => {
      unregister()
      await sdk.shutdown()
      trace.disable()
      context.disable()
      propagation.disable()
    },
  }
}
