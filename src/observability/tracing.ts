// src/observability/tracing.ts
//
// OpenTelemetry tracing bootstrap. Loaded via `--import ./src/observability/tracing.ts`
// (dev, tsx) or `--import ./dist/observability/tracing.js` (prod) — BEFORE
// `src/index.ts` ever runs. That ordering is the whole point: Node's
// `--import` loads this module before any other import in the process, which
// is the only way auto-instrumentation (HTTP, Express, ioredis, Winston) can
// patch those libraries before the app itself requires them.
//
// Because this runs before anything else, it CANNOT use `@/configs/env.config`
// — `getEnv()` hasn't been (and can't yet be) called, and importing
// `env.config.ts` here would run its own `dotenv.config()` a second time, out
// of order, before this module has decided whether tracing is even wanted.
// This file reads `process.env` directly instead — the one deliberate
// exception to this repo's own `no-restricted-properties` rule outside
// `env.config.ts`/`logger.service.ts`/`index.ts` (see eslint.config.mjs).
// `console.info`/`console.error` are used for the same reason: the Winston
// logger (`@/services/logger.service`) is not loaded yet, and even once it
// is, this instrumentation must not depend on the very library it patches.
//
// Traces only — no metrics, no OTLP log export, no sampling knob. See
// CLAUDE.md's "Observability" section for what this deliberately does not
// cover (Postgres, direct `redis` client calls) and why.
import type { IncomingMessage } from 'node:http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

// Liveness/readiness probes fire every few seconds and produce nothing worth
// a trace — same two paths app.ts registers before any other route.
const IGNORED_INCOMING_PATHS = new Set(['/health', '/health/ready'])

/**
 * Build (but do not start) the NodeSDK instance for a given OTLP endpoint.
 * Split out from the module-scope no-op check below purely so that check can
 * stay a `const` rather than a top-level `let` reassigned conditionally.
 * @param endpoint - The raw `OTEL_EXPORTER_OTLP_ENDPOINT` value (already
 *   confirmed non-empty by the caller).
 * @returns A configured, not-yet-started `NodeSDK`.
 */
function buildSdk(endpoint: string): NodeSDK {
  const serviceName = process.env.OTEL_SERVICE_NAME || 'express-boilerplate'
  const deploymentEnvironment = process.env.NODE_ENV || 'development'
  const tracesUrl = `${endpoint.replace(/\/$/, '')}/v1/traces`

  return new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      // 'deployment.environment.name' is the (incubating) semconv attribute
      // key — spelled as a literal rather than imported from
      // '@opentelemetry/semantic-conventions/incubating' to keep this file's
      // dependency surface to the stable package only.
      'deployment.environment.name': deploymentEnvironment,
    }),
    traceExporter: new OTLPTraceExporter({ url: tracesUrl }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage): boolean =>
          IGNORED_INCOMING_PATHS.has((request.url ?? '').split('?', 1)[0] ?? ''),
      }),
      new ExpressInstrumentation(),
      // Patches ioredis — the client `queue.service.ts` (BullMQ) uses.
      // `redis.service.ts`'s own direct Redis calls go through node-redis
      // (the `redis` package), which this instrumentation does NOT cover —
      // see CLAUDE.md's Observability section.
      new IORedisInstrumentation(),
      new WinstonInstrumentation({
        // No OTLP log pipeline in this boilerplate — Winston's own
        // transports own log output (see logger.service.ts). Leaving this
        // at its `false` default makes the instrumentation try to
        // `require('@opentelemetry/winston-transport')` on every
        // `createLogger()` call, a package this repo does not install; it
        // fails soft (a diag warning), but there is no reason to pay for it.
        disableLogSending: true,
        // logger.service.ts's own `addRequestContext` format already reads
        // `trace.getActiveSpan()` directly and writes `traceId`/`spanId`
        // (camelCase, alongside `requestId`) onto every log record — that
        // works whether or not this instrumentation is registered. Its own
        // correlation feature would additionally stamp `trace_id`/`span_id`/
        // `trace_flags` (snake_case) onto the same record; disabled here so
        // log output carries one naming convention, not two.
        disableLogCorrelation: true,
      }),
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
 * A no-op when tracing was never started (`OTEL_EXPORTER_OTLP_ENDPOINT`
 * unset) — `sdk` is `undefined` in that case, so this resolves immediately
 * without throwing. Safe to call unconditionally from `server.ts`.
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
