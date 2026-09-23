// src/observability/tracing.ts
//
// OpenTelemetry tracing bootstrap. Loaded via `--import ./src/observability/tracing.ts`
// (dev, tsx) or `--import ./dist/observability/tracing.js` (prod) — BEFORE
// `src/index.ts` ever runs. That ordering is the whole point: Node's
// `--import` loads this module before any other import in the process, which
// is the only way auto-instrumentation (HTTP, Express, ioredis, pino) can
// patch those libraries before the app itself requires them.
//
// Because this runs before anything else, it CANNOT use `@/configs/env.config`
// — `getEnv()` hasn't been (and can't yet be) called, and importing
// `env.config.ts` here would run its own `dotenv.config()` a second time, out
// of order, before this module has decided whether tracing is even wanted.
// This file reads `process.env` directly instead — the one deliberate
// exception to this repo's own `no-restricted-properties` rule outside
// `env.config.ts`/`logger.service.ts`/`index.ts` (see eslint.config.mjs).
// `console.info`/`console.error` are used for the same reason: the app's
// own logger (`@/services/logger.service`) is not loaded yet, and even once
// it is, this instrumentation must not depend on the very library it patches.
//
// Traces and logs — no metrics, no sampling knob. See CLAUDE.md's
// "Observability" section for what this deliberately does not cover
// (Postgres, direct `redis` client calls) and why.
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

// pino is CommonJS imported from ESM; OTel's require-hook never sees that
// load. The ESM loader hook (import-in-the-middle) makes the instrumentation
// patch it. Must run before the app's own imports, which --import guarantees.
// Gated on the same env var buildSdk() itself checks below — installing an
// ESM loader hook that wraps every module load in the process is not free,
// and doing it unconditionally would break this file's own documented
// invariant (CLAUDE.md's Observability section): "no OTEL_EXPORTER_OTLP_ENDPOINT
// ⇒ complete no-op."
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // eslint-disable-next-line sonarjs/deprecation -- see the disable comment on the `register` import above
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
}

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
  const baseUrl = endpoint.replace(/\/$/, '')

  return new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      // 'deployment.environment.name' is the (incubating) semconv attribute
      // key — spelled as a literal rather than imported from
      // '@opentelemetry/semantic-conventions/incubating' to keep this file's
      // dependency surface to the stable package only.
      'deployment.environment.name': deploymentEnvironment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${baseUrl}/v1/traces` }),
    // @opentelemetry/sdk-logs@0.222.0's `BatchLogRecordProcessor` takes a
    // single options object (`{ exporter, ... }`), not `(exporter, config)`
    // positionally — passing the exporter positionally silently leaves
    // `this._exporter` undefined inside the processor (confirmed: the
    // record never reached the collector, and `shutdown()` threw trying to
    // read `.shutdown` off it). See `BatchLogRecordProcessorOptions` in that
    // package's `types.d.ts`.
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${baseUrl}/v1/logs` }) }),
    ],
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
      // Log SENDING on: every pino record becomes an OTel log record carrying
      // the active span's trace context, exported to the collector → Loki.
      // Log CORRELATION off: logger.service.ts's mixin already writes
      // traceId/spanId (camelCase) into the stdout JSON; letting the
      // instrumentation add trace_id/span_id as well would duplicate them.
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
