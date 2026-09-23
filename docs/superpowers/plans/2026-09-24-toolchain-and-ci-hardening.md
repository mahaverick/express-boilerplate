# Toolchain & CI Hardening (express-boilerplate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add helmet, replace winston with pino whose records reach Loki linked to traces, make the container start OpenTelemetry, provision pnpm through an explicitly installed Corepack, ignore agent files, switch to Renovate, add release-please, and turn `ci.yml` into the gate of a new `deploy.yml`.

**Architecture:** The `logger` facade in `src/services/logger.service.ts` keeps its public API; pino replaces winston underneath and a Slack destination replaces the winston transport. `src/observability/tracing.ts` adds an OTLP log exporter and `PinoInstrumentation`; the collector forwards logs to a new Loki service and Grafana links logs ↔ traces. CI gains `workflow_call` so `deploy.yml` can run it before building and pushing an image to GHCR.

**Tech Stack:** Node 24, pnpm 12.4.1, TypeScript ~6.0.3, Express 5.2.1, Vitest 5, pino 10.3.1, pino-pretty 13.1.3, helmet 8.3.0, OpenTelemetry JS 0.222.0, Grafana Loki 3.7.8, GitHub Actions, Renovate, release-please v5.

**Spec:** `docs/superpowers/specs/2026-09-24-toolchain-and-ci-hardening-design.md` (read it before starting; this plan argues from it). The react half lives in `react-boilerplate/docs/superpowers/plans/2026-09-24-toolchain-and-ci-hardening.md`.

**Branch:** `feat/toolchain-ci-hardening` (already created; the spec is commit `7b8b9d6`).

## Global Constraints

- Node **24** (`.nvmrc` 24, `engines.node >=24`, `node:24-alpine`). Do **not** move to 26 — that is a dated follow-up after 2026-10-28.
- `packageManager: "pnpm@12.4.1"` is the only place the pnpm version is written.
- Corepack is installed explicitly: `npm i -g corepack@0.36.0 && corepack enable`.
- **Keep** `@/` extensionless imports, `tsx`, `tsc` + `tsc-alias`, `dotenv`, ESLint. Do not add oxlint, OpenAPI, Sentry or OTel metrics.
- Exact versions: `pino@10.3.1`, `pino-pretty@13.1.3` (devDependency), `helmet@8.3.0`, `@opentelemetry/instrumentation-pino@0.68.0`, `@opentelemetry/exporter-logs-otlp-http@0.222.0`, `@opentelemetry/sdk-logs@0.222.0`, `grafana/loki:3.7.8`.
- Remove: `winston`, `winston-transport`, `@opentelemetry/instrumentation-winston`, `.github/dependabot.yml`.
- Log JSON shape stays: keys `level` (label string), `timestamp` (ISO), `message`, `source`, plus `requestId`, `tenantId`, `traceId`, `spanId` when present; `Error` values serialised as `{ name, message, stack }`.
- Hooks and scripts call `pnpm exec`, never `npx` (CLAUDE.md "Git hooks and CI").
- Tests that need Postgres/Redis live under `tests/integration/`, never `tests/unit/`.
- Conventional commits; every commit ends with the two attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v`.
- Implementers: if the brief is wrong against the code, **argue, don't comply** — say so with evidence (CLAUDE.md "Writing a plan for this repo").

## Review Focus

1. **Reusable-workflow concurrency collision.** GitHub concurrency group names are case-insensitive and a called workflow sees the _caller's_ `github.workflow`. If `ci.yml` keeps `group: ${{ github.workflow }}-${{ github.ref }}`, a `deploy.yml` run on `main` (`group: deploy-…`) and its called CI (`Deploy-…`) collide. Task 9 keys the CI group on `ci-${{ github.event_name }}-${{ github.ref }}` and a step asserts it.
2. **`LOG_LEVEL=debug` silently dropping debug lines.** `pino.multistream` entries default to level `info`; the console entry must carry `level: options.level`. Task 3 has a test for debug output with Slack configured.
3. **Production image without pino-pretty.** Dev deps are pruned from the runtime image; the pretty path must never be reached when `NODE_ENV=production`. Task 4 runs the built image and asserts JSON output.
4. **helmet's CORP breaking the sibling frontend.** `same-site` must still let `WEB_URL`'s origin use the API. Task 5 requires `tests/integration/api/cors.test.ts` and `notification-stream.test.ts` to pass unchanged.
5. **Renovate proposing forbidden majors.** TypeScript 7 (typescript-eslint peers `<6.1.0`) and Node 26 images before LTS. Task 7's config holds both back and a validator step checks the file.

---

## File map

| File                                                                                           | Change                                         | Task          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------- |
| `docker-compose.yml`                                                                           | add `loki`; Grafana `depends_on`               | 1             |
| `otel-collector.yaml`                                                                          | logs → `otlphttp/loki`                         | 1             |
| `docker/grafana/provisioning/datasources/tempo.yaml`                                           | uid + tracesToLogsV2                           | 1             |
| `docker/grafana/provisioning/datasources/loki.yaml`                                            | new                                            | 1             |
| `src/observability/tracing.ts`                                                                 | log exporter + PinoInstrumentation             | 2             |
| `package.json` / `pnpm-lock.yaml`                                                              | deps                                           | 2, 3, 5       |
| `src/services/logger.service.ts`                                                               | winston → pino                                 | 3             |
| `tests/unit/services/logger.service.test.ts`                                                   | re-pointed at pino                             | 3             |
| `tests/unit/services/slack-transport.test.ts`                                                  | re-pointed at pino                             | 3             |
| `Dockerfile`                                                                                   | CMD `--import`; Corepack                       | 4, 6          |
| `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`                                    | docs follow behaviour                          | 4, 5, 6, 8, 9 |
| `src/configs/helmet.config.ts`                                                                 | new                                            | 5             |
| `src/app.ts`                                                                                   | mount helmet first                             | 5             |
| `tests/integration/api/security-headers.test.ts`                                               | new                                            | 5             |
| `.devcontainer/devcontainer.json`                                                              | Corepack                                       | 6             |
| `.gitignore`                                                                                   | agent entries                                  | 6             |
| `renovate.json`                                                                                | new; delete `.github/dependabot.yml`           | 7             |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json` | new                                            | 8             |
| `.github/workflows/ci.yml`                                                                     | triggers, permissions, concurrency, docker job | 9             |
| `.github/workflows/deploy.yml`                                                                 | new                                            | 9             |

---

### Task 1: Loki in the local observability stack

**Files:**

- Modify: `docker-compose.yml` (services block; `grafana.depends_on`)
- Modify: `otel-collector.yaml`
- Modify: `docker/grafana/provisioning/datasources/tempo.yaml`
- Create: `docker/grafana/provisioning/datasources/loki.yaml`

**Interfaces:**

- Produces: a Loki service reachable **only** inside the compose network at `http://loki:3100` (OTLP ingest at `/otlp`, query at `/loki/api/v1/query_range`); Grafana datasource uids `tempo` and `loki`.

- [ ] **Step 1: Add the Loki service.** In `docker-compose.yml`, directly after the `tempo:` service, add:

```yaml
loki:
  # Single-binary Loki with the image's bundled local config (tsdb, schema
  # v13 — required for OTLP ingest and structured metadata). No host port:
  # Grafana already owns host 3100, and nothing outside the compose network
  # needs Loki directly — query it through Grafana.
  image: grafana/loki:3.7.8
  command: ['-config.file=/etc/loki/local-config.yaml']
```

and change Grafana's `depends_on: [tempo]` to `depends_on: [tempo, loki]`.

- [ ] **Step 2: Route collector logs to Loki.** In `otel-collector.yaml`, add under `exporters:` (after the existing `otlphttp:` block):

```yaml
# Loki 3.x ingests OTLP natively at /otlp; the collector appends
# /v1/logs itself. trace_id/span_id arrive as structured metadata.
otlphttp/loki:
  endpoint: http://loki:3100/otlp
```

and change the logs pipeline line to:

```yaml
logs: { receivers: [otlp], exporters: [otlphttp/loki, debug] }
```

- [ ] **Step 3: Give Tempo a uid and a link to logs.** Replace the `datasources:` list in `docker/grafana/provisioning/datasources/tempo.yaml` with:

```yaml
datasources:
  - name: Tempo
    type: tempo
    uid: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: true
    editable: false
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceId: true
        spanStartTimeShift: '-5m'
        spanEndTimeShift: '5m'
```

- [ ] **Step 4: Add the Loki datasource.** Create `docker/grafana/provisioning/datasources/loki.yaml`:

```yaml
# docker/grafana/provisioning/datasources/loki.yaml — auto-provisions Loki so
# log lines link to their trace in Tempo. OTLP-ingested records carry
# trace_id as structured metadata (not in the log body), hence
# matcherType: label.
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      derivedFields:
        - name: TraceID
          matcherType: label
          matcherRegex: trace_id
          datasourceUid: tempo
          url: '$${__value.raw}'
          urlDisplayLabel: View trace
```

- [ ] **Step 5: Verify the stack comes up.**

Run: `docker compose up -d && sleep 15 && docker compose ps --format '{{.Service}} {{.State}}'`
Expected: `loki running`, `grafana running`, `otel-collector running`, `tempo running` (plus the existing services).

Run: `NET=$(docker inspect "$(docker compose ps -q loki)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'); docker run --rm --network "$NET" curlimages/curl:8.16.0 -s http://loki:3100/ready`
Expected: `ready` (Loki can take ~15 s after start; retry once if it says `Ingester not ready`).

Run: `docker compose logs grafana 2>&1 | grep -iE "error.*datasource|failed to provision" || echo "provisioning clean"`
Expected: `provisioning clean`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml otel-collector.yaml docker/grafana/provisioning/datasources/
git commit -m "feat(observability): add Loki and link logs with traces in Grafana

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 2: OTel log export + proof that pino records reach Loki (GATE)

This is the spec's "prove first" task. **Do not start Task 3 until Step 6 passes.** A scratch probe during design could not observe any OTel log record even for a direct emit, so nothing about this path is known to work yet.

**Files:**

- Modify: `src/observability/tracing.ts`
- Modify: `package.json`, `pnpm-lock.yaml`
- Temporary (never committed): `otel-log-probe.ts` at the repo root

**Interfaces:**

- Consumes: Loki from Task 1.
- Produces: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every pino record emitted in-process is exported over OTLP to `${endpoint}/v1/logs` with the active span's trace context. `shutdownOtel()` unchanged (flushes logs too, since `NodeSDK.shutdown()` shuts the logger provider).

- [ ] **Step 1: Install dependencies.**

```bash
pnpm add pino@10.3.1 @opentelemetry/instrumentation-pino@0.68.0 @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/sdk-logs@0.222.0
pnpm remove @opentelemetry/instrumentation-winston
```

- [ ] **Step 2: Wire the log exporter and instrumentation.** In `src/observability/tracing.ts`:

Replace the import `import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston'` with:

```ts
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
```

(keep the imports alphabetised the way `@ianvs/prettier-plugin-sort-imports` wants — `pnpm format` will fix order).

In `buildSdk`, replace `const tracesUrl = \`${endpoint.replace(/\/$/, '')}/v1/traces\`` with:

```ts
const baseUrl = endpoint.replace(/\/$/, '')
```

and in the `NodeSDK` options replace `traceExporter: new OTLPTraceExporter({ url: tracesUrl }),` with:

```ts
    traceExporter: new OTLPTraceExporter({ url: `${baseUrl}/v1/traces` }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${baseUrl}/v1/logs` })),
    ],
```

and replace the `new WinstonInstrumentation({ … })` entry with:

```ts
      // Log SENDING on: every pino record becomes an OTel log record carrying
      // the active span's trace context, exported to the collector → Loki.
      // Log CORRELATION off: logger.service.ts's mixin already writes
      // traceId/spanId (camelCase) into the stdout JSON; letting the
      // instrumentation add trace_id/span_id as well would duplicate them.
      new PinoInstrumentation({ disableLogCorrelation: true }),
```

Update the file's header comment wherever it mentions winston so it describes pino and log export (grep: `grep -n -i winston src/observability/tracing.ts` must print nothing).

- [ ] **Step 3: Write the throwaway probe.** Create `otel-log-probe.ts` at the repo root (do **not** `git add` it):

```ts
// Throwaway: proves pino → OTel → collector → Loki end to end. Delete after Task 2.
import { trace } from '@opentelemetry/api'
import pino from 'pino'
import { shutdownOtel } from './src/observability/tracing'

const log = pino({ messageKey: 'message' })
const traceId = trace.getTracer('probe').startActiveSpan('probe-span', (span) => {
  log.info({ probe: true }, 'otel-log-probe')
  span.end()
  return span.spanContext().traceId
})
console.log(`PROBE_TRACE_ID=${traceId}`)
await shutdownOtel()
```

- [ ] **Step 4: Run the probe under the dev loader (tsx), exactly as `pnpm dev` loads tracing.**

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=otel-log-probe \
  pnpm exec tsx --import ./src/observability/tracing.ts otel-log-probe.ts | tee /tmp/probe.out
```

Expected: `[OTEL] tracing initialized …`, a JSON line with `"message":"otel-log-probe"`, and `PROBE_TRACE_ID=<32 hex>`.

- [ ] **Step 5: Query Loki for that trace id.**

```bash
TID=$(grep -o 'PROBE_TRACE_ID=[0-9a-f]*' /tmp/probe.out | cut -d= -f2); sleep 5
NET=$(docker inspect "$(docker compose ps -q loki)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" curlimages/curl:8.16.0 -sG http://loki:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="otel-log-probe"}' --data-urlencode 'since=10m' \
  | grep -c "$TID"
```

Expected: a count **≥ 1** (the trace id appears as `trace_id` structured metadata on the `otel-log-probe` record).

- [ ] **Step 6: Decide.**
  - Count ≥ 1 → **PASS.** Go to Step 8.
  - Count 0 → run `docker compose logs otel-collector --since 5m | grep -i -A3 "logrecord\|otel-log-probe"`.
    - Nothing in the collector's debug output ⇒ the SDK is not emitting: apply the **ESM-hook fallback** (Step 7) and repeat Steps 4–5.
    - The record is in the collector but not Loki ⇒ the collector→Loki leg is wrong (check `docker compose logs loki`), fix Task 1's config, repeat Step 5.
  - Still 0 after the fallback ⇒ **STOP** and report to the human partner with the collector and Loki output. Do not continue to Task 3.

- [ ] **Step 7 (only if Step 6 says so): ESM loader-hook fallback.**

```bash
pnpm add @opentelemetry/instrumentation@0.222.0
```

Add as the **first** statements of `src/observability/tracing.ts`, before any other import-dependent code (imports are hoisted, so put these two lines at the very top of the import block and the `register` call immediately after the imports, before `buildSdk` is defined):

```ts
import { register } from 'node:module'
```

```ts
// pino is CommonJS imported from ESM; OTel's require-hook never sees that
// load. The ESM loader hook (import-in-the-middle) makes the instrumentation
// patch it. Must run before the app's own imports, which --import guarantees.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
```

Repeat Steps 4–6.

- [ ] **Step 8: Clean up and run the unit tests.**

```bash
rm otel-log-probe.ts /tmp/probe.out
pnpm exec vitest run tests/unit/observability/tracing.test.ts
pnpm lint
```

Expected: tracing tests PASS (the no-op branch is unchanged); lint clean.

- [ ] **Step 9: Commit** (record in the message which path passed — plain or ESM hook).

```bash
git add src/observability/tracing.ts package.json pnpm-lock.yaml
git commit -m "feat(observability): export pino logs over OTLP with trace context

Proven end to end: a pino record emitted inside a span reached Loki
carrying that span's trace_id (<plain require-hook | ESM loader hook>).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 3: Replace winston with pino behind the `logger` facade

**Files:**

- Modify: `src/services/logger.service.ts` (full rewrite below)
- Modify: `tests/unit/services/logger.service.test.ts`
- Modify: `tests/unit/services/slack-transport.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `pino` (Task 2), `requestContextStore` from `@/middlewares/request-context.middleware`, `getEnv()` from `@/configs/env.config`.
- Produces (exported from `@/services/logger.service`):
  - `logger: { error|warn|info|debug(message: string, meta?: Record<string, unknown>): void }` — **unchanged**.
  - `getCallerSource(): string` — **unchanged**.
  - `interface LoggerOptions { level: string; isProduction: boolean; slackWebhookUrl?: string; slackLogLevel?: string; destination?: DestinationStream }`
  - `createPinoLogger(options: LoggerOptions): Logger` (replaces `createWinstonLogger`). **Call shape changes for direct users:** pino is `log.info(meta, message)`, not `log.info(message, meta)`. Only the tests call it directly; the 31 `logger` importers are unaffected.
  - `createSlackDestination(options: { webhookUrl: string }): DestinationStream`.

- [ ] **Step 1: Install / remove packages.**

```bash
pnpm add -D pino-pretty@13.1.3
pnpm remove winston winston-transport
```

- [ ] **Step 2: Rewrite the tests first.** In `tests/unit/services/logger.service.test.ts`:

1. Replace the header comment's winston-specific paragraphs with:

```ts
// Exercises pino logger construction via `createPinoLogger`, never the
// `logger` singleton's own destination — the singleton is memoised off
// `getEnv()`, so a test that wants a specific format builds its own logger
// with a capture `destination`. The singleton tests spy on
// `process.stdout.write`, which is where both the production JSON stream and
// the development pino-pretty stream write.
```

2. Replace `captureStdout` / `ConsoleWithInternalStreams` with:

```ts
import { Writable } from 'node:stream'

/**
 * A real Writable that records each chunk as a trimmed string. A real stream
 * (not a `{ write }` literal) because pino-pretty pipes into its destination.
 * @returns The stream to pass as `destination`, and the captured lines.
 */
function captureDestination(): { destination: Writable; output: string[] } {
  const output: string[] = []
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) output.push(line.trim())
      }
      callback()
    },
  })
  return { destination, output }
}

/**
 * Spy on process.stdout.write — where the singleton's stream writes.
 * @returns The captured lines, in write order.
 */
function captureStdout(): string[] {
  const output: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) output.push(line.trim())
    }
    return true
  })
  return output
}
```

3. Change the import to `import { createPinoLogger, getCallerSource, logger } from '@/services/logger.service'`.

4. In every `createWinstonLogger` test: build with `const { destination, output } = captureDestination()` and `createPinoLogger({ …same options…, destination })`, and swap argument order — e.g. `log.info('test message', { source: 'test.ts:1' })` becomes `log.info({ source: 'test.ts:1' }, 'test message')`, `log.error('something broke', { error: testError, source: 'test.ts:1' })` becomes `log.error({ error: testError, source: 'test.ts:1' }, 'something broke')`. Keep every assertion. Rename `describe('createWinstonLogger'` to `describe('createPinoLogger'`.

5. In the development-format test change `expect(line).toContain('info')` to `expect(line).toMatch(/info/i)` (pino-pretty prints `INFO`).

6. Add two new tests inside `describe('createPinoLogger')`:

```ts
describe('JSON shape parity with the winston era', () => {
  it('emits level as a label, an ISO timestamp, and no pid/hostname', () =>
    new Promise<void>((resolve) => {
      const { destination, output } = captureDestination()
      const log = createPinoLogger({ level: 'info', isProduction: true, destination })

      log.info({ source: 'test.ts:1' }, 'shape check')

      setImmediate(() => {
        const parsed = parseLastRecord(output)
        expect(parsed.level).toBe('info')
        expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(parsed.message).toBe('shape check')
        expect(parsed).not.toHaveProperty('pid')
        expect(parsed).not.toHaveProperty('hostname')
        expect(parsed).not.toHaveProperty('msg')
        expect(parsed).not.toHaveProperty('time')
        resolve()
      })
    }))
})

describe('level filtering with Slack configured (multistream)', () => {
  it('still writes debug lines to the console when level is debug', () =>
    new Promise<void>((resolve) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
      const { destination, output } = captureDestination()
      const log = createPinoLogger({
        level: 'debug',
        isProduction: true,
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        slackLogLevel: 'error',
        destination,
      })

      log.debug({ source: 'test.ts:1' }, 'debug survives multistream')

      setImmediate(() => {
        expect(output.some((line) => line.includes('debug survives multistream'))).toBe(true)
        vi.unstubAllGlobals()
        resolve()
      })
    }))
})
```

7. In `tests/unit/services/slack-transport.test.ts`: change the import to `createPinoLogger`, rewrite the header comment's winston sentences to say the Slack destination is exercised through `createPinoLogger` via `pino.multistream`, add `destination: new Writable({ write(_c, _e, cb) { cb() } })` (import `Writable` from `node:stream`) to every `createPinoLogger({ … })` call so console output doesn't pollute the run, and swap every call to `(meta, message)` order. Keep all 12 cases and their assertions.

- [ ] **Step 3: Run the tests to see them fail.**

Run: `pnpm exec vitest run tests/unit/services/logger.service.test.ts tests/unit/services/slack-transport.test.ts`
Expected: FAIL — `createPinoLogger` is not exported.

- [ ] **Step 4: Rewrite `src/services/logger.service.ts`.** Keep `parseStackFrame` and `getCallerSource` **exactly** as they are today (lines 1–78 region: their JSDoc and bodies unchanged). Replace everything from the winston import line and from `const addRequestContext` to the end of the file so the module reads:

```ts
// src/services/logger.service.ts
//
// The one place anything in this codebase should write a log line. A pino
// logger, lazily constructed (same pattern as getEnv()/getRedis()) so
// importing this module never has a side effect. It keeps the JSON shape the
// winston version had — `level` as a label, `timestamp`, `message` — plus a
// mixin that pulls correlation data out of AsyncLocalStorage and the active
// span, and a formatter that turns any Error-valued field into
// { name, message, stack } (JSON.stringify of a bare Error is "{}").
import { createRequire } from 'node:module'
import { trace } from '@opentelemetry/api'
import pino, { type DestinationStream, type Logger, type StreamEntry } from 'pino'
import type { PrettyOptions } from 'pino-pretty'
import { getEnv } from '@/configs/env.config'
import { requestContextStore } from '@/middlewares/request-context.middleware'

// parseStackFrame(...) and getCallerSource(...) — unchanged, keep verbatim.

/**
 * Correlation fields for the current call: request/tenant from the request's
 * AsyncLocalStorage context, trace/span from the active OTel span. Absent
 * fields are omitted, never written as undefined.
 * @returns The fields to merge into every record.
 */
function requestContextFields(): Record<string, string> {
  const fields: Record<string, string> = {}
  const context = requestContextStore.getStore()
  if (context?.requestId) fields.requestId = context.requestId
  if (context?.tenant?.tenantId) fields.tenantId = context.tenant.tenantId
  const span = trace.getActiveSpan()
  if (span) {
    const spanContext = span.spanContext()
    fields.traceId = spanContext.traceId
    fields.spanId = spanContext.spanId
  }
  return fields
}

/**
 * Replace every Error-valued key with a plain { name, message, stack } object.
 * @param object - The merged log object pino is about to serialise.
 * @returns A shallow copy with Errors made serialisable.
 */
function serializeErrors(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    result[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
  }
  return result
}

export interface LoggerOptions {
  level: string
  isProduction: boolean
  slackWebhookUrl?: string
  slackLogLevel?: string
  /** Where console output goes. Defaults to process.stdout; tests pass a capture stream. */
  destination?: DestinationStream
}

const DEDUP_WINDOW_MS = 60_000

const LEVEL_COLORS: Record<string, string> = {
  error: '#E01E5A',
  warn: '#ECB22E',
  info: '#2EB67D',
  debug: '#36C5F0',
}

const LEVEL_EMOJI: Record<string, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🔵',
  debug: '⚪',
}

interface DedupEntry {
  count: number
  firstSeen: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * POST a payload to the Slack webhook. Never throws: a failed alert must not
 * become a second failure. console.error, not logger — re-entering the logger
 * from its own destination would recurse.
 * @param webhookUrl - The Slack incoming-webhook URL.
 * @param payload - The message body.
 */
async function sendToSlack(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      console.error('Slack webhook failed', response.status)
    }
  } catch (error: unknown) {
    console.error('Slack webhook failed', error)
  }
}

/**
 * Build the Slack Block Kit payload for one log record.
 * @param info - The parsed JSON log record.
 * @returns The webhook body.
 */
function buildSlackPayload(info: Record<string, unknown>): Record<string, unknown> {
  const level = typeof info.level === 'string' ? info.level : 'error'
  const message = typeof info.message === 'string' ? info.message : ''
  const source = typeof info.source === 'string' ? info.source : 'unknown'
  const requestId = typeof info.requestId === 'string' ? info.requestId : undefined
  const timestamp = typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString()
  const errorStack =
    info.error && typeof info.error === 'object' && 'stack' in info.error
      ? info.error.stack
      : undefined
  const stack = typeof errorStack === 'string' ? errorStack : undefined

  const fields = [
    { type: 'mrkdwn', text: `*Source:* \`${source}\`` },
    { type: 'mrkdwn', text: `*Time:* ${timestamp}` },
  ]
  if (requestId) {
    fields.push({ type: 'mrkdwn', text: `*Request:* \`${requestId}\`` })
  }

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${LEVEL_EMOJI[level] ?? '⚪'} ${message}`.slice(0, 150) },
    },
    { type: 'section', fields },
  ]
  if (stack) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${stack.slice(0, 2900)}\`\`\`` },
    })
  }

  return { attachments: [{ color: LEVEL_COLORS[level] ?? '#808080', blocks }] }
}

/**
 * Build the "suppressed N duplicates" summary sent when a dedup window closes.
 * @param source - The record's source field.
 * @param message - The record's message.
 * @param suppressedCount - How many repeats were swallowed.
 * @returns The webhook body.
 */
function buildSlackSummaryPayload(
  source: string,
  message: string,
  suppressedCount: number
): Record<string, unknown> {
  return {
    text: `⚠️ Suppressed ${suppressedCount} duplicate occurrence${suppressedCount === 1 ? '' : 's'} of "${message}" from \`${source}\` in the last 60s`,
  }
}

/**
 * A pino destination that forwards records to Slack, deduplicating by
 * `${source}:${message}` within a 60 s window: the first occurrence sends at
 * once, repeats are counted, and one summary is sent when the window closes
 * if there were any. Level filtering is done by pino.multistream, not here.
 * @param options - The webhook URL.
 * @returns A destination for pino.multistream.
 */
export function createSlackDestination(options: { webhookUrl: string }): DestinationStream {
  const dedup = new Map<string, DedupEntry>()
  return {
    write(line: string): void {
      let info: Record<string, unknown>
      try {
        info = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const source = typeof info.source === 'string' ? info.source : 'unknown'
      const message = typeof info.message === 'string' ? info.message : ''
      const key = `${source}:${message}`

      const existing = dedup.get(key)
      if (existing) {
        existing.count++
        return
      }

      const timer = setTimeout(() => {
        const entry = dedup.get(key)
        dedup.delete(key)
        if (entry && entry.count > 1) {
          void sendToSlack(
            options.webhookUrl,
            buildSlackSummaryPayload(source, message, entry.count - 1)
          )
        }
      }, DEDUP_WINDOW_MS)
      timer.unref()

      dedup.set(key, { count: 1, firstSeen: Date.now(), timer })
      void sendToSlack(options.webhookUrl, buildSlackPayload(info))
    },
  }
}

const requireCjs = createRequire(import.meta.url)

/**
 * Human-readable development output. pino-pretty is a devDependency: this is
 * only reached when isProduction is false, and it is loaded with requireCjs()
 * here — not a top-level import — so the pruned production image never
 * resolves it.
 * @param destination - Where the pretty text goes.
 * @returns A pino destination.
 */
function createPrettyStream(destination: DestinationStream): DestinationStream {
  const { build } = requireCjs('pino-pretty') as {
    build: (options: PrettyOptions) => DestinationStream
  }
  return build({
    destination,
    colorize: destination === process.stdout && process.stdout.isTTY,
    messageKey: 'message',
    timestampKey: 'timestamp',
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'source,requestId',
    messageFormat: (log, messageKey) => {
      const source = typeof log.source === 'string' ? ` [${log.source}]` : ''
      const requestId = typeof log.requestId === 'string' ? ` (${log.requestId.slice(0, 8)})` : ''
      const message =
        typeof log[messageKey] === 'string' ? log[messageKey] : JSON.stringify(log[messageKey])
      return `${source}${requestId} ${message}`.trim()
    },
  })
}

/**
 * Build a pino logger. Production writes JSON; development writes
 * pino-pretty text. With a Slack webhook, records at or above
 * slackLogLevel are also sent to Slack via pino.multistream.
 * @param options - Level, format, Slack settings, optional destination.
 * @returns The pino logger.
 */
export function createPinoLogger(options: LoggerOptions): Logger {
  const base = options.destination ?? process.stdout
  const consoleStream = options.isProduction ? base : createPrettyStream(base)

  const streams: StreamEntry[] = [
    // level MUST be explicit: a multistream entry defaults to 'info', which
    // would silently drop debug lines when LOG_LEVEL=debug.
    { level: options.level as pino.Level, stream: consoleStream },
  ]
  if (options.slackWebhookUrl) {
    streams.push({
      level: (options.slackLogLevel ?? 'error') as pino.Level,
      stream: createSlackDestination({ webhookUrl: options.slackWebhookUrl }),
    })
  }

  return pino(
    {
      level: options.level,
      base: undefined,
      messageKey: 'message',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      mixin: requestContextFields,
      formatters: {
        level: (label) => ({ level: label }),
        log: serializeErrors,
      },
    },
    pino.multistream(streams)
  )
}

const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    const env = getEnv()
    cached ??= createPinoLogger({
      level: env.LOG_LEVEL,
      isProduction: env.NODE_ENV === 'production',
      ...(env.SLACK_WEBHOOK_URL !== undefined && { slackWebhookUrl: env.SLACK_WEBHOOK_URL }),
      slackLogLevel: env.SLACK_LOG_LEVEL,
    })
    return cached
  }
})()

/**
 * The application logger. Every method adds the caller's file:line as
 * `source`; request/tenant/trace correlation is added by the mixin.
 */
export const logger = {
  error(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('error')) return
    l.error({ ...meta, source: getCallerSource() }, message)
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('warn')) return
    l.warn({ ...meta, source: getCallerSource() }, message)
  },
  info(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('info')) return
    l.info({ ...meta, source: getCallerSource() }, message)
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('debug')) return
    l.debug({ ...meta, source: getCallerSource() }, message)
  },
}
```

Notes for the implementer:

- `getCallerSource`'s path stripping (`/dist/`, `/src/`, `file://`) stays as is.
- If the existing JSDoc on `logger` methods is richer than above, keep the existing wording.
- If typescript-eslint objects to `options.level as pino.Level`, validate instead: `const level = LEVELS.has(options.level) ? options.level : 'info'` with `const LEVELS = new Set(['error','warn','info','debug'])` — the env schema already restricts `LOG_LEVEL` to these four, so this is belt-and-braces, not new behaviour. Say which you did in the report.
- If pino.multistream turns out to ignore the label formatter for level routing (it should route on the numeric level it tracks internally), the two new tests in Step 2 will show it — report, don't paper over.

- [ ] **Step 5: Run the logger tests.**

Run: `pnpm exec vitest run tests/unit/services/logger.service.test.ts tests/unit/services/slack-transport.test.ts`
Expected: PASS, all cases (existing + 2 new).

- [ ] **Step 6: Run the whole gate.**

Run: `pnpm lint && pnpm test:coverage` (compose stack up)
Expected: lint clean; all tests pass; coverage thresholds (80 %) met.

Run: `grep -rn -i "winston" src tests package.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/services/logger.service.ts tests/unit/services/logger.service.test.ts tests/unit/services/slack-transport.test.ts package.json pnpm-lock.yaml
git commit -m "refactor(logging): replace winston with pino behind the logger facade

Same JSON shape, correlation fields, error serialisation, caller source
and Slack dedup; Slack becomes a pino.multistream destination.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 4: Container starts OTel; prove the real app's logs reach Loki; docs

**Files:**

- Modify: `Dockerfile` (the `CMD` line only)
- Modify: `CLAUDE.md` (sections "Logging", "Observability", and the "Writing a plan for this repo" anecdote)
- Modify: `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` (every winston mention)

**Interfaces:**

- Consumes: Tasks 1–3.

- [ ] **Step 1: Fix the CMD.** In `Dockerfile` replace `CMD ["node", "dist/index.js"]` with:

```dockerfile
# Same as `pnpm start`: tracing.js must load via --import, before the app, or
# OpenTelemetry (traces AND logs) never starts in the container.
CMD ["node", "--import", "./dist/observability/tracing.js", "dist/index.js"]
```

- [ ] **Step 2: Prove the dev app path.** With the compose stack up and a `.env` present:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev > /tmp/dev.log 2>&1 &
DEV_PID=$!; sleep 8
curl -s http://localhost:4040/api/v1/does-not-exist > /dev/null   # 404 path logs a line inside a request span
sleep 6; kill $DEV_PID
NET=$(docker inspect "$(docker compose ps -q loki)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" curlimages/curl:8.16.0 -sG http://loki:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="express-boilerplate"}' --data-urlencode 'since=10m' | grep -o '"trace_id":"[0-9a-f]*"' | head -3
```

Expected: at least one `"trace_id":"…"` line. If the 404 path does not log, use any route that does (`grep -rn "logger\.\(info\|warn\)" src/middlewares/error.middleware.ts` shows what the error path logs); state which request you used in the report.

- [ ] **Step 3: Prove the production image path.**

```bash
docker build -t express-boilerplate:otel .
NET=$(docker inspect "$(docker compose ps -q loki)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm -d --name eb-otel --network "$NET" --env-file .env \
  -e NODE_ENV=production -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 -e OTEL_SERVICE_NAME=eb-image-proof \
  -e DATABASE_URL="$(grep ^DATABASE_URL .env | cut -d= -f2- | sed 's/localhost:5433/postgres:5432/')" \
  -e REDIS_URL="$(grep ^REDIS_URL .env | cut -d= -f2- | sed 's/localhost:6380/redis:6379/')" \
  -p 4041:4040 express-boilerplate:otel
sleep 8; docker logs eb-otel 2>&1 | head -5
curl -s http://localhost:4041/api/v1/does-not-exist > /dev/null; sleep 6
docker run --rm --network "$NET" curlimages/curl:8.16.0 -sG http://loki:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="eb-image-proof"}' --data-urlencode 'since=10m' | grep -c trace_id
docker rm -f eb-otel
```

Expected: `docker logs` shows `[OTEL] tracing initialized` and **JSON** log lines (no pino-pretty text, no `Cannot find module 'pino-pretty'`); the Loki count is ≥ 1. If the service hostnames or ports differ, read them from `docker-compose.yml` and adjust — say so in the report.

- [ ] **Step 4: Update docs.**
  - `CLAUDE.md` "Logging": replace "talks to Winston's console transport and uses `console.error` in the Slack transport's failure path" with "writes through pino and uses `console.error` in the Slack destination's failure path"; replace "Slack transport deduplicates" with "Slack destination deduplicates"; add a bullet: "**pino, JSON in production, pino-pretty in development.** `createPinoLogger` keeps the winston-era shape (`level` label, ISO `timestamp`, `message`). Direct pino calls are `(meta, message)`; application code uses the `logger` facade, which keeps `(message, meta)`."
  - `CLAUDE.md` "Observability": add a bullet: "**Logs reach Loki.** `PinoInstrumentation` (log sending on, correlation off — the mixin already writes `traceId`/`spanId`) exports records over OTLP; the collector forwards to Loki; in Grafana a log line links to its trace and a trace to its logs. Loki has no host port — query it through Grafana." If Task 2 needed the ESM hook, add: "**`tracing.ts` registers OTel's ESM loader hook** — without it the CommonJS pino imported from ESM is never patched (proved 2026-09-24)." Also add: "**The Docker image loads tracing via `--import`** (Dockerfile CMD mirrors `pnpm start`)."
  - `CLAUDE.md` "Writing a plan for this repo": change "a logging library that does not exist here (there is no pino; …)" to "a logging library that did not exist here at the time (there was no pino until 2026-09-24; …)".
  - `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`: `grep -n -i winston README.md ARCHITECTURE.md STRUCTURE.md` and rewrite each hit for pino; add Loki wherever the compose services are listed.

Run: `grep -rn -i winston --exclude-dir=node_modules --exclude-dir=docs --exclude-dir=.git . `
Expected: no output (historical specs/plans under `docs/` are left alone).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile CLAUDE.md README.md ARCHITECTURE.md STRUCTURE.md
git commit -m "fix(docker): load tracing via --import so the image runs OpenTelemetry

Also documents pino logging and the Loki log path.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 5: helmet security headers

**Files:**

- Create: `src/configs/helmet.config.ts`
- Modify: `src/app.ts` (mount before `cors`)
- Create: `tests/integration/api/security-headers.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `SECURITY.md` (headers section), `CLAUDE.md` (Code conventions or Auth section — one bullet)

**Interfaces:**

- Produces: `export const helmetOptions: HelmetOptions` from `@/configs/helmet.config`.

- [ ] **Step 1: Install.** `pnpm add helmet@8.3.0`

- [ ] **Step 2: Write the failing test.** Create `tests/integration/api/security-headers.test.ts` (integration: `createApp()` touches env and the health route touches Postgres/Redis):

```ts
// tests/integration/api/security-headers.test.ts
//
// helmet is mounted first in createApp(), so every response — success, 404,
// a 415 rejection, a 401 from the SSE route, and CORS preflights — carries
// the same headers. The CORS/SSE sibling-origin behaviour is covered by
// cors.test.ts and notification-stream.test.ts, which must pass unchanged:
// that is the proof `Cross-Origin-Resource-Policy: same-site` doesn't break
// the second frontend.
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'

const app = createApp()

/**
 * Assert the helmet header set configured in helmet.config.ts.
 * @param headers - The supertest response headers.
 */
function expectSecurityHeaders(headers: Record<string, string | undefined>): void {
  expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'")
  expect(headers['cross-origin-resource-policy']).toBe('same-site')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
  expect(headers['x-powered-by']).toBeUndefined()
}

describe('security headers', () => {
  it('are set on GET /health', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expectSecurityHeaders(response.headers)
  })

  it('are set on a 404', async () => {
    const response = await request(app).get('/api/v1/does-not-exist')
    expect(response.status).toBe(404)
    expectSecurityHeaders(response.headers)
  })

  it('are set on a 415 rejection from the auth routes', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .type('form')
      .send('email=a@example.com&password=x')
    expect(response.status).toBe(415)
    expectSecurityHeaders(response.headers)
  })

  it('are set on the SSE route even when it rejects an unauthenticated request', async () => {
    const response = await request(app).get('/api/v1/notifications/stream')
    expect(response.status).toBe(401)
    expectSecurityHeaders(response.headers)
  })

  it('are set on a CORS preflight', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
    expect(response.status).toBe(204)
    expectSecurityHeaders(response.headers)
  })
})
```

Before running, confirm the 415 and 401 expectations against the code (`grep -n "415" src/middlewares/content-type.middleware.ts`, and how `notification.routes.ts` rejects an unauthenticated stream). If either returns a different status, use the real one and say so.

- [ ] **Step 3: Run it to verify it fails.**

Run: `pnpm exec vitest run tests/integration/api/security-headers.test.ts`
Expected: FAIL — `content-security-policy` is undefined.

- [ ] **Step 4: Implement.** Create `src/configs/helmet.config.ts`:

```ts
// src/configs/helmet.config.ts
//
// Security headers for a JSON-only API. Nothing here serves HTML, so the CSP
// forbids everything and framing entirely. CORP is `same-site`, not helmet's
// default `same-origin`: the second frontend on a sibling subdomain
// (cors.config.ts) must still be able to read responses. HSTS stays at
// helmet's default — browsers only honour it over HTTPS.
import type { HelmetOptions } from 'helmet'

export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
}
```

In `src/app.ts` add `import helmet from 'helmet'` and `import { helmetOptions } from '@/configs/helmet.config'`, and insert **immediately before** `app.use(cors(corsOptions))`:

```ts
// First middleware: every response — preflights, 404s, errors — gets the
// security headers, not just the ones that reach a router.
app.use(helmet(helmetOptions))
```

Leave `app.disable('x-powered-by')` in place (harmless, and explicit).

- [ ] **Step 5: Run the new test and the CORS/SSE suites.**

Run: `pnpm exec vitest run tests/integration/api/security-headers.test.ts tests/integration/api/cors.test.ts tests/integration/api/notification-stream.test.ts`
Expected: PASS, with **no edits** to `cors.test.ts` or `notification-stream.test.ts`.

- [ ] **Step 6: Docs.** In `SECURITY.md` add a "Security headers" subsection listing the five headers above and why CORP is `same-site`; in `CLAUDE.md` add one bullet under "Code conventions": "**helmet is the first middleware** (`src/configs/helmet.config.ts`). Anything that must answer without security headers does not exist here; don't mount routes above it."

- [ ] **Step 7: Full gate, then commit.**

Run: `pnpm lint && pnpm test:coverage`
Expected: clean, all pass.

```bash
git add src/configs/helmet.config.ts src/app.ts tests/integration/api/security-headers.test.ts package.json pnpm-lock.yaml SECURITY.md CLAUDE.md
git commit -m "feat(security): add helmet headers for the JSON API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 6: Corepack provisioning and agent `.gitignore` entries

**Files:**

- Modify: `Dockerfile` (`base` and `deps` stages)
- Modify: `.devcontainer/devcontainer.json`
- Modify: `README.md` (Requirements section)
- Modify: `.gitignore`

- [ ] **Step 1: Dockerfile.** In the `base` stage replace `RUN corepack enable && corepack prepare pnpm@12.4.1 --activate` with:

```dockerfile
# Corepack is installed explicitly: Node 25+ no longer bundles it, and doing it
# now makes the Node 26 move a version bump only. The pnpm version itself comes
# from package.json's packageManager field (see `corepack install` in deps).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm i -g corepack@0.36.0 && corepack enable
```

In the `deps` stage, directly after `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./`, add:

```dockerfile
RUN corepack install
```

- [ ] **Step 2: devcontainer.** Set `"postCreateCommand": "npm i -g corepack@0.36.0 && corepack enable && pnpm install",`.

- [ ] **Step 3: README.** In "Requirements", replace "enable it with `corepack enable`" with "install Corepack and enable it with `npm i -g corepack@0.36.0 && corepack enable` — Node 25+ no longer ships Corepack, so this works on Node 24 and 26 alike".

- [ ] **Step 4: .gitignore.** After the existing `.superpowers/` line add:

```gitignore
# Claude Code: per-machine files that must never be committed
.claude/worktrees/
.claude/settings.local.json
# May hold database credentials — commit an .mcp.json.example instead
.mcp.json
```

- [ ] **Step 5: Verify.**

Run: `docker build -t express-boilerplate:corepack . && docker run --rm --entrypoint pnpm express-boilerplate:corepack --version`
Expected: build succeeds; prints `12.4.1`.

Run: `for p in .claude/worktrees/x .claude/settings.local.json .superpowers/x .mcp.json; do git check-ignore -q "$p" && echo "ignored $p" || echo "NOT ignored $p"; done`
Expected: four `ignored` lines.

Run: `grep -rn "pnpm@12" --exclude=pnpm-lock.yaml --exclude-dir=node_modules --exclude-dir=docs . `
Expected: only `package.json` (`"packageManager": "pnpm@12.4.1"`).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .devcontainer/devcontainer.json README.md .gitignore
git commit -m "chore: install Corepack explicitly and ignore agent files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 7: Renovate replaces dependabot

**Files:**

- Create: `renovate.json`
- Delete: `.github/dependabot.yml`
- Modify: `CLAUDE.md` ("Git hooks and CI": one bullet), `CONTRIBUTING.md` (if it mentions dependabot)

- [ ] **Step 1: Create `renovate.json`:**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":semanticCommits", "helpers:pinGitHubActionDigests"],
  "schedule": ["before 6am on monday"],
  "minimumReleaseAge": "3 days",
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": ["before 6am on the first day of the month"]
  },
  "packageRules": [
    {
      "description": "typescript-eslint peers typescript <6.1.0; TS 7 breaks type-aware lint (see CLAUDE.md)",
      "matchPackageNames": ["typescript"],
      "allowedVersions": "<6.1.0"
    },
    {
      "description": "Stay on Node 24 LTS until the planned move to Node 26 after 2026-10-28",
      "matchDatasources": ["docker"],
      "matchPackageNames": ["node"],
      "allowedVersions": "<25"
    },
    {
      "groupName": "dev tooling",
      "matchPackageNames": [
        "eslint",
        "eslint-*",
        "@eslint/*",
        "typescript-eslint",
        "prettier",
        "prettier-*",
        "@ianvs/prettier-plugin-sort-imports",
        "vitest",
        "@vitest/*"
      ]
    },
    { "groupName": "opentelemetry", "matchPackageNames": ["@opentelemetry/*"] },
    { "groupName": "types", "matchPackageNames": ["@types/*"] }
  ]
}
```

- [ ] **Step 2: Delete dependabot.** `git rm .github/dependabot.yml`

- [ ] **Step 3: Validate.**

Run: `pnpm dlx --package=renovate@44 renovate-config-validator renovate.json`
Expected: `Config validated successfully` (or equivalent success line; no errors).

- [ ] **Step 4: Docs.** `CLAUDE.md` "Git hooks and CI" gains: "**Renovate, not dependabot.** Weekly, grouped, 3-day minimum release age, actions pinned to SHAs. TypeScript is held `<6.1.0` and the `node` image `<25` by `renovate.json` rules — lift them deliberately, not by merging a Renovate PR. Requires the Renovate GitHub App on the repo." `grep -rn -i dependabot --exclude-dir=node_modules --exclude-dir=docs .` → rewrite any hit.

- [ ] **Step 5: Commit**

```bash
git add renovate.json CLAUDE.md CONTRIBUTING.md
git commit -m "chore(deps): replace dependabot with Renovate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

(`git rm` already staged the deletion.)

---

### Task 8: release-please

**Files:**

- Create: `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`
- Modify: `CONTRIBUTING.md` (a "Releases" section)

- [ ] **Step 1: Create `release-please-config.json`** — `bootstrap-sha` is `main`'s HEAD when this plan was written, so the first release notes cover only work after it:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bootstrap-sha": "033f080",
  "packages": {
    ".": {
      "release-type": "node",
      "include-component-in-tag": false,
      "changelog-path": "CHANGELOG.md"
    }
  }
}
```

Confirm `git rev-parse --short origin/main` is still `033f080`; if main has moved, use the commit this branch was cut from (`git merge-base origin/main HEAD`) and say so.

- [ ] **Step 2: Create `.release-please-manifest.json`:**

```json
{ ".": "1.0.0" }
```

- [ ] **Step 3: Create `.github/workflows/release.yml`:**

```yaml
name: Release

# Opens/updates a release PR from conventional commits on main; merging that
# PR tags vX.Y.Z and creates the GitHub Release. The PR is opened with
# GITHUB_TOKEN, so it gets NO CI runs (GitHub never triggers workflows from
# GITHUB_TOKEN events) — acceptable while main is unprotected; switch to a
# GitHub App token once required checks exist.
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: googleapis/release-please-action@v5
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 4: Validate the YAML.** `pnpm dlx @action-validator/cli@0.6.0 .github/workflows/release.yml` — if that package is unavailable, run `docker run --rm -v "$PWD":/repo rhysd/actionlint:1.7.7 -color /repo/.github/workflows/release.yml`. Expected: no errors.

- [ ] **Step 5: Docs.** `CONTRIBUTING.md` gains a "Releases" section: release-please reads conventional commits on `main`; `feat` → minor, `fix` → patch, `feat!`/`BREAKING CHANGE` → major; merge the release PR to tag; release PRs show no CI checks (reason above).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml release-please-config.json .release-please-manifest.json CONTRIBUTING.md
git commit -m "ci: add release-please for versioned releases and changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 9: CI as the gate of a new deploy workflow

**Files:**

- Modify: `.github/workflows/ci.yml` (header block, plus a new `docker` job)
- Create: `.github/workflows/deploy.yml`
- Modify: `CLAUDE.md` ("Git hooks and CI"), `README.md` (a "Deploying" section)

- [ ] **Step 1: Rewrite the `ci.yml` header.** Replace everything from `on:` through the `concurrency:` block (lines 2–8) with:

```yaml
on:
  pull_request:
    branches: [main]
  # Called by deploy.yml as the gate before an image is built.
  workflow_call:
  workflow_dispatch:

# Keyed on the event, NOT github.workflow: when deploy.yml calls this file,
# github.workflow is the CALLER's name, and concurrency group names are
# case-insensitive — "Deploy-refs/heads/main" would collide with deploy.yml's
# own "deploy-refs/heads/main" group. Only PR runs are cancelled by a newer
# push; a gate run on main is never killed half-way.
concurrency:
  group: ci-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read
```

(The `develop` branch in the old trigger does not exist — dropped.)

- [ ] **Step 2: Add a `docker` job** at the end of `jobs:` in `ci.yml`:

```yaml
docker:
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@v7
    - name: Build the production image (no push)
      run: docker build -t express-boilerplate:ci .
```

- [ ] **Step 3: Create `.github/workflows/deploy.yml`:**

```yaml
name: Deploy

# main → CI gate → image on GHCR → deploy. The deploy job is a placeholder
# until a target (Cloud Run / GKE / VM) is chosen; replace its step then.
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  image:
    needs: ci
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha,format=long
            type=raw,value=main
      - id: build
        uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: mode=max
          sbom: true
      - uses: actions/attest-build-provenance@v4
        with:
          subject-name: ghcr.io/${{ github.repository }}
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
      - name: Summary
        run: |
          {
            echo "### Image"
            echo ""
            echo "\`ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}\`"
          } >> "$GITHUB_STEP_SUMMARY"

  deploy:
    needs: image
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    steps:
      - name: Deploy (placeholder — no target chosen yet)
        run: echo "Would deploy ghcr.io/${{ github.repository }}@${{ needs.image.outputs.digest }}"
```

- [ ] **Step 4: Lint the workflows.**

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.7 -color`
Expected: no errors for `ci.yml`, `deploy.yml`, `release.yml`, `gitleaks.yml`.

Run: `grep -n "group:" .github/workflows/ci.yml .github/workflows/deploy.yml`
Expected: `ci-${{ github.event_name }}-${{ github.ref }}` and `deploy-${{ github.ref }}` — never both starting with the same word.

Run: `grep -c "^  [a-z]*:$" .github/workflows/ci.yml` and eyeball that the "Assert the CI env block mirrors .env.test" step still greps `.github/workflows/ci.yml` (unchanged path).

- [ ] **Step 5: Docs.** `CLAUDE.md` "Git hooks and CI" gains: "**`ci.yml` is also the deploy gate.** `deploy.yml` (push to `main`) calls it via `workflow_call`, then builds and pushes `ghcr.io/<repo>:sha-<commit>` and `:main` with SBOM and provenance attestations, then runs a placeholder `deploy` job bound to the `production` environment. Keep CI's concurrency group keyed on `github.event_name` — see the comment in `ci.yml`." `README.md` gains a short "Deploying" section saying the same in two sentences and that the deploy step is a placeholder.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml CLAUDE.md README.md
git commit -m "ci: reuse CI as the gate of a deploy workflow that publishes to GHCR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TSY5ETVc1EHHmpEnAqTa7v"
```

---

### Task 10: Whole-branch verification

- [ ] **Step 1:** `pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm test:coverage && pnpm build` — all green (compose stack up).
- [ ] **Step 2:** `pnpm audit --prod` — no new advisories versus `main`.
- [ ] **Step 3:** `docker build -t express-boilerplate:final .` — succeeds.
- [ ] **Step 4:** `git log --oneline main..HEAD` — one commit per task (spec + Tasks 1–9), all conventional, all with the attribution lines.
- [ ] **Step 5:** Report the manual follow-ups for the human partner: install the Renovate GitHub App; create the `production` GitHub Environment (Settings → Environments) or the first deploy run creates it; after merging, confirm the first `deploy.yml` run shows `ci → image → deploy` and the GHCR package has `sha-…` and `main` tags.
