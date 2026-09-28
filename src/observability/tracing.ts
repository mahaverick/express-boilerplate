/**
 * @file OpenTelemetry bootstrap for traces and logs, loaded with `--import`
 * before the app so auto-instrumentation can patch HTTP, Express, ioredis and
 * pino before they load. It runs before env validation, so it reads
 * `process.env` directly (`.env` arrives through `--env-file-if-exists`) and
 * writes with `console`, never the logger it instruments. Without
 * OTEL_EXPORTER_OTLP_ENDPOINT it is a complete no-op.
 */
import type { IncomingMessage } from 'node:http'
// eslint-disable-next-line sonarjs/deprecation -- `register()` is deprecated in favor of `module.registerHooks()`, but that replacement takes a synchronous hooks object, not a loader specifier; `@opentelemetry/instrumentation@0.222.0`'s `hook.mjs` only exports the async `load`/`resolve`/`initialize` shape `register()` expects, so this is the only integration path this package version offers (see the `register()` call below)
import { register } from 'node:module'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

// OTel's require-hook never sees CommonJS pino imported from ESM; the loader hook does.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // eslint-disable-next-line sonarjs/deprecation -- see the disable comment on the `register` import above
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
}

/**
 * Health probes fire every few seconds and produce nothing worth a trace.
 */
const IGNORED_INCOMING_PATHS = new Set(['/health', '/health/ready'])

/**
 * Resource attributes for this process's traces and logs.
 * @param source - The raw environment, normally `process.env`.
 * @returns `service.name`, plus `deployment.environment.name` when `APP_ENV` is set.
 */
export function tracingResourceAttributes(
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: source.OTEL_SERVICE_NAME || 'express-boilerplate',
    // An incubating semconv key, spelled out to stay on the stable package.
    ...(source.APP_ENV && { 'deployment.environment.name': source.APP_ENV }),
  }
}

/**
 * Build (but do not start) the NodeSDK instance for a given OTLP endpoint.
 * Log records carry the active span's context to the collector; the pino
 * instrumentation's own correlation is off because the logger's mixin
 * already writes `traceId`/`spanId`. ioredis (BullMQ) is instrumented;
 * node-redis (redis.service.ts) and postgres.js are not.
 * @param endpoint - The raw `OTEL_EXPORTER_OTLP_ENDPOINT` value (already
 *   confirmed non-empty by the caller).
 * @returns A configured, not-yet-started `NodeSDK`.
 */
function buildSdk(endpoint: string): NodeSDK {
  const baseUrl = endpoint.replace(/\/$/, '')

  return new NodeSDK({
    resource: resourceFromAttributes(tracingResourceAttributes(process.env)),
    traceExporter: new OTLPTraceExporter({ url: `${baseUrl}/v1/traces` }),
    // sdk-logs takes `{ exporter }`: a positional exporter is silently dropped.
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${baseUrl}/v1/logs` }) }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage): boolean =>
          IGNORED_INCOMING_PATHS.has((request.url ?? '').split('?', 1)[0] ?? ''),
      }),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
      new PinoInstrumentation({ disableLogCorrelation: true }),
    ],
  })
}

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const sdk = otlpEndpoint ? buildSdk(otlpEndpoint) : undefined

if (sdk) {
  sdk.start()
  console.info(`[OTEL] tracing initialized (endpoint=${otlpEndpoint})`)
} else {
  console.info('[OTEL] OTEL_EXPORTER_OTLP_ENDPOINT is not set — tracing is disabled (no-op)')
}

/**
 * Flush and shut down the OpenTelemetry SDK as part of graceful shutdown.
 *
 * Resolves at once when tracing was never started, so `server.ts` calls it
 * unconditionally. A shutdown failure is logged, never thrown.
 * @returns Resolves once the SDK has flushed and shut down, or immediately
 *   if tracing was never started.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return

  try {
    await sdk.shutdown()
    console.info('[OTEL] tracing shut down')
  } catch (error) {
    console.error('[OTEL] error shutting down tracing', error)
  }
}
