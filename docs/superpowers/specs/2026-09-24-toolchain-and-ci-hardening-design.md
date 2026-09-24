# Toolchain & CI hardening — design

**Date:** 2026-09-24 · **Status:** approved in conversation, awaiting written-spec review
**Repos:** `express-boilerplate` (this spec's home) and `react-boilerplate`
**Origin:** starter-kit audit, `~/Mahaverick/docs/2026-09-24-starter-kit-audit.md` (SP1 plus parts of SP3).

## Goal

Make both boilerplates safer to start from: explicit pnpm provisioning ready for Node 26, security headers on the API, pino logging whose records reach Loki linked to their traces, a container that actually starts OpenTelemetry, git hooks in react, Renovate, release-please, and a CI workflow that doubles as the gate in front of a deploy workflow.

## Decisions already made (do not reopen in the plan)

| Topic           | Decision                                                                                           | Why                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | Stay on **Node 24 LTS**. Node 26 is a dated follow-up (below)                                      | Node 26 is "Current" until its LTS on 2026-10-28                                                                                                                                                                                                                                                         |
| pnpm            | **Keep Corepack, install it explicitly** (`npm i -g corepack@0.36.0`)                              | Node ≥25 no longer bundles Corepack; installing it now makes the Node 26 flip a version bump only                                                                                                                                                                                                        |
| Imports / build | **Keep `@/` extensionless imports, `tsx`, `tsc` + `tsc-alias`, `dotenv`**                          | Node's type stripping ignores tsconfig `paths` and requires extensions; the user prefers the current import style                                                                                                                                                                                        |
| Linter          | **Keep ESLint** (no oxlint)                                                                        | Trial on scratch copies: oxlint drops 6 deliberately configured rules (`jsdoc/require-jsdoc`, `jsdoc/check-param-names`, `jsdoc/check-alignment`, `jsdoc/no-undefined-types`, `import-x/no-useless-path-segments`, `unicorn/name-replacements`) plus ~170 unicorn preset rules; its JS plugins are alpha |
| Logger          | **pino 10** replaces winston                                                                       | pino and winston are both CommonJS (verified), so the OTel/ESM risk is identical; pino is faster and actively released                                                                                                                                                                                   |
| Log path        | pino JSON → stdout, **and** OTel Logs SDK → collector → **Loki**                                   | Logs linked to Tempo traces in Grafana                                                                                                                                                                                                                                                                   |
| Registry        | **GHCR**                                                                                           | Zero setup, `GITHUB_TOKEN` with `packages: write`                                                                                                                                                                                                                                                        |
| Deploy step     | **Placeholder** until a deploy target is chosen                                                    | Target (Cloud Run / GKE / VM) is an open question in the audit                                                                                                                                                                                                                                           |
| Out of scope    | OTel metrics, Sentry, OpenAPI, oxlint, removing tsx/dotenv, SHA-pinning by hand (Renovate does it) | Later sub-projects                                                                                                                                                                                                                                                                                       |

## Section 1 — Packaging, Node and Corepack (both repos)

1. Every place that runs `corepack enable` installs Corepack first:
   - `express-boilerplate/Dockerfile`: the `base` stage runs `RUN npm i -g corepack@0.36.0 && corepack enable` with `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0` — replacing `corepack prepare pnpm@12.4.1 --activate`. The `deps` stage, right after `COPY package.json …`, runs `RUN corepack install` so the pnpm version comes from `packageManager`.
   - `express-boilerplate/.devcontainer/devcontainer.json`: `postCreateCommand` becomes `npm i -g corepack@0.36.0 && corepack enable && pnpm install`.
   - `react-boilerplate/Dockerfile`: same pattern — install/enable Corepack, then `corepack install` after `package.json` is copied.
   - Both READMEs: prerequisites say `npm i -g corepack@0.36.0 && corepack enable` (works on Node 24 and on Node 26).
2. `packageManager: "pnpm@12.4.1"` is the **only** place the pnpm version is written.
   - react gains `packageManager`, `engines: { "node": ">=24" }`, `.nvmrc` (`24`), and `.npmrc` with `engine-strict=true` — mirroring express.
   - Adding `packageManager` makes pnpm 12 write `packageManagerDependencies` into `pnpm-lock.yaml`; regenerate the lockfile **in the same commit**, then delete the react Dockerfile comment explaining why the field was avoided and the matching comment in react `ci.yml`.
   - CI keeps `pnpm/action-setup@v6` (reads `packageManager`; needs no Corepack). Remove any `version:` input so the field stays the single source.
3. **Dated follow-up (not in this work), on or after 2026-10-28:** one PR per repo changing `.nvmrc` → `26`, `engines.node` → `>=26`, Docker bases → `node:26-alpine`, CI `node-version` (`@types/node` is already 26.x in both repos). Nothing else should need to change.

**Acceptance:** `docker build` succeeds for both repos with the new lines; `pnpm install --frozen-lockfile` passes in react CI after the lockfile regen; `grep -rn "pnpm@12" --exclude=pnpm-lock.yaml` finds only `package.json`.

## Section 2 — express: helmet, pino, OpenTelemetry logs

### 2.1 helmet 8.3.0

- Mounted **first** in `src/app.ts`, before `cors`, so preflights and error responses carry the headers too.
- Configuration (JSON API — no HTML served):
  - `contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }`
  - `crossOriginResourcePolicy: { policy: 'same-site' }` — the sibling-subdomain frontend must keep working.
  - `referrerPolicy: { policy: 'no-referrer' }`
  - HSTS: helmet default (browsers ignore it over plain HTTP).
  - `X-Powered-By` removed (helmet default).
- **Tests** (`tests/integration/api/security-headers.test.ts`): assert the headers on `GET /health`, an authenticated API route, a 404 and an error response, and the SSE stream response. Every existing CORS / sibling-origin test (refresh cookie, SSE stream) must pass unchanged — that is the proof `same-site` CORP doesn't break the second frontend.

### 2.2 pino 10.3.1 behind the existing `logger` facade

The public surface does **not** change: `logger.error|warn|info|debug(message: string, meta?: Record<string, unknown>)`, `getCallerSource()`. None of the 31 importing files change.

| Winston today                        | pino implementation                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWinstonLogger(options)`       | `createPinoLogger(options)` (same `LoggerOptions`); tests updated to the new name                                                                                                                                                                                                                                                |
| `format.json()` with `message` key   | `messageKey: 'message'`; `formatters.level: (label) => ({ level: label })`; `timestamp: () => \`,"timestamp":"${new Date().toISOString()}"\``(field name stays`timestamp`, ISO in every environment; pino's `isoTime`would name it`time`)                                                                                        |
| `addRequestContext` format           | `mixin()` returning `requestId`, `tenantId`, `traceId`, `spanId` from `requestContextStore` and `trace.getActiveSpan()` — same camelCase names                                                                                                                                                                                   |
| `serializeErrors` format             | `formatters.log(obj)` replaces every `Error`-valued key with `{ name, message, stack }`                                                                                                                                                                                                                                          |
| Dev colourised printf                | `pino-pretty` 13.1.3 (**devDependency**) as a stream, only when `NODE_ENV !== 'production'`; loaded with `createRequire(import.meta.url)('pino-pretty')` inside that branch, so the factory stays synchronous and the production image (pruned of dev deps) never resolves it                                                    |
| `SlackTransport` (winston-transport) | `createSlackDestination({ webhookUrl })` — an in-process writable (`{ write(line) }`) that parses the JSON line and reuses the **same** payload builders, 60 s dedup map, summary message, error handling and `requestId` field; attached via `pino.multistream([{ stream: console }, { level: slackLogLevel, stream: slack }])` |
| `l.isErrorEnabled()` etc.            | `l.isLevelEnabled('error')` etc.                                                                                                                                                                                                                                                                                                 |
| Lazy singleton `getLogger()`         | unchanged                                                                                                                                                                                                                                                                                                                        |

Dependencies: add `pino@10.3.1`, dev `pino-pretty@13.1.3`; remove `winston`, `winston-transport`.
Tests: `logger.service.test.ts` and `slack-transport.test.ts` keep every existing case (JSON shape, context fields, error serialisation, caller source, level gating, all 12 Slack cases) re-pointed at pino; assert against captured destination output rather than winston internals.

### 2.3 OpenTelemetry log export

- `src/observability/tracing.ts`:
  - Replace `WinstonInstrumentation` with `new PinoInstrumentation({ disableLogCorrelation: true })` — log **sending** on; correlation off because the mixin already writes `traceId`/`spanId` into stdout JSON, and OTel log records carry trace context natively.
  - Add `logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: \`${endpoint}/v1/logs\` }))]`to the`NodeSDK` config.
  - Deps: add `@opentelemetry/instrumentation-pino@0.68.0`, `@opentelemetry/exporter-logs-otlp-http@0.222.0`, `@opentelemetry/sdk-logs@0.222.0`; remove `@opentelemetry/instrumentation-winston`.
  - Still a complete no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
- **ESM caveat — prove first.** pino is CommonJS imported from ESM. OTel's `require` hook may not patch it on that path. The **first implementation task** is an end-to-end proof: compose up, `pnpm dev`, one request, then query Loki (`/loki/api/v1/query_range`) for that request's log line and assert it carries the request's trace id. If the proof fails, register OTel's ESM loader hook at the top of `tracing.ts` (`register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)` from `node:module`) and re-run. Do not continue past this task until the proof passes. (A scratch probe during design could not observe any log record even for a direct `logs.getLogger().emit()` call — the harness itself was wrong, so the ESM question is genuinely open, not answered.)
- `otel-collector.yaml`: logs pipeline exporters become `[otlphttp/loki, debug]` with `otlphttp/loki: { endpoint: http://loki:3100/otlp }`.
- `docker-compose.yml`: add `loki` (`grafana/loki:3.7.8`, `-config.file=/etc/loki/local-config.yaml` using the image's single-binary local config, **no host port** — Grafana already owns host 3100); Grafana `depends_on: [tempo, loki]`.
- `docker/grafana/provisioning/datasources/`: add `loki.yaml` (uid `loki`; `derivedFields: [{ name: TraceID, matcherType: label, matcherRegex: trace_id, datasourceUid: tempo, url: '$${__value.raw}' }]` — OTLP-ingested records carry `trace_id` as structured metadata, not in the body) and give the Tempo datasource a uid plus `tracesToLogsV2: { datasourceUid: loki }`.
- **Container fix:** `Dockerfile` `CMD` becomes `["node", "--import", "./dist/observability/tracing.js", "dist/index.js"]`, matching `pnpm start`. Today the image never starts OTel.

**Acceptance:** the Loki proof above passes; in Grafana, a trace opens its logs and a log line opens its trace; `pnpm test:coverage` stays ≥ 80 %; `docker run` of the built image prints `[OTEL] tracing initialized` when the endpoint is set.

## Section 3 — Repo hygiene and CI/CD (both repos)

### 3.1 react git hooks

- devDependencies: `@commitlint/cli@21.2.3`, `@commitlint/config-conventional@21.2.3`, `lint-staged@17.5.1`; add `commitlint.config.js` identical to express's.
- `lint-staged` in `package.json`: `*.{ts,tsx}` → `eslint --fix --max-warnings 0`, `prettier --write`; `*.{js,jsx,css,json,md,html}` → `prettier --write`.
- `.husky/pre-commit`: lockfile-drift check (`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null`), `pnpm exec lint-staged`, `pnpm exec vitest run --changed HEAD --passWithNoTests`.
- `.husky/commit-msg`: `pnpm exec commitlint --edit "$1"`.
- `.husky/pre-push`: `pnpm lint && pnpm typecheck && pnpm test` — no e2e (keeps the push well under the time that has previously dropped SSH pushes).
- **Acceptance:** `git ls-files .husky` lists the three hooks; a bad commit message is rejected locally.

### 3.2 `.gitignore` (both repos)

Add `.claude/worktrees/`, `.claude/settings.local.json`, `.superpowers/` (react), `.mcp.json`. Verify with `git check-ignore -v` for each path.

### 3.3 Renovate replaces dependabot

- Delete `express-boilerplate/.github/dependabot.yml`. Add `renovate.json` to both repos:
  - `extends: ["config:recommended", ":semanticCommits", "helpers:pinGitHubActionDigests"]`
  - `minimumReleaseAge: "3 days"`, `lockFileMaintenance: { enabled: true, schedule: ["before 6am on the first day of the month"] }`, `schedule: ["before 6am on monday"]`
  - `packageRules` groups — express: `dev-tooling` (eslint*, typescript-eslint, prettier*, vitest, @vitest/*), `opentelemetry` (`@opentelemetry/*`), `types` (`@types/*`); react: the same plus `tanstack` (`@tanstack/*`).
- Docker base images and GitHub Actions are covered by `config:recommended`; the first Renovate PR pins every action to a SHA.
- **Manual step (user):** install the Renovate GitHub App on both repos.

### 3.4 release-please

- `.github/workflows/release.yml`: on `push: main`, `permissions: { contents: write, pull-requests: write }`, one step `googleapis/release-please-action@v5` with `config-file: release-please-config.json`, `manifest-file: .release-please-manifest.json`.
- `release-please-config.json`: `{ "packages": { ".": { "release-type": "node", "include-component-in-tag": false } } }`; `.release-please-manifest.json`: `{ ".": "1.0.0" }` (current `package.json` versions).
- Known limitation: PRs opened with `GITHUB_TOKEN` don't trigger CI, so release PRs show no checks. Acceptable while `main` is unprotected (verified: not protected); switch to a GitHub App token when required checks are added.

### 3.5 CI as the gate before deploy

**`ci.yml` (both):**

- `on: { pull_request: { branches: [main] }, workflow_call: {}, workflow_dispatch: {} }` — express drops the nonexistent `develop`; react drops `push: main` (moves to `deploy.yml`, so `main` isn't tested twice).
- Top-level `permissions: { contents: read }` (express adds it).
- `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`.
- express gains a `docker` job: `docker build -t express-boilerplate:ci .` (no push), mirroring react's.

**`deploy.yml` (both, new):**

```yaml
on: { push: { branches: [main] }, workflow_dispatch: {} }
concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  ci:
    uses: ./.github/workflows/ci.yml
  image:
    needs: ci
    permissions: { contents: read, packages: write, id-token: write, attestations: write }
    # buildx (setup-buildx-action@v4) + login-action@v4 to ghcr.io +
    # metadata-action@v6 tags: type=sha,format=long and type=raw,value=main +
    # build-push-action@v7 with cache-from/to type=gha, provenance: mode=max, sbom: true, push: true +
    # attest-build-provenance@v4 on the pushed digest; digest written to $GITHUB_STEP_SUMMARY
  deploy:
    needs: image
    environment: production
    # PLACEHOLDER: echoes the image digest. Replace with the real deploy once a target is chosen.
```

Image name: `ghcr.io/mahaverick/<repo>`. react's `ci.yml` keeps its e2e and docker jobs, so they run inside the gate.

**Acceptance:** on a PR only `ci.yml` runs; on merge to `main`, `deploy.yml` runs `ci → image → deploy`; a failing `ci` stops `image`; the GHCR package shows `sha-<commit>` and `main` tags with provenance and SBOM attestations.

## Delivery

Two branches, one per repo, `feat/toolchain-ci-hardening`; conventional commits; each section lands as its own commit(s). express first (it holds this spec and the riskier Section 2), then react. CLAUDE.md / README / CONTRIBUTING updated in the same commits as the behaviour they describe (logger, hooks, release flow, deploy workflow).

## Risks

| Risk                                           | Mitigation                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OTel doesn't patch pino under ESM              | First-task Loki proof; ESM loader hook fallback; stop if neither works                                |
| `same-site` CORP breaks the sibling frontend   | Existing CORS/SSE sibling-origin tests must pass unchanged                                            |
| react lockfile regen pulls unintended upgrades | Regenerate with `pnpm install --lockfile-only` and diff: only `packageManagerDependencies` may change |
| Renovate floods PRs on day one                 | Groups + weekly schedule + 3-day release age; first PR is the action-SHA pinning                      |
| Release PRs have no CI                         | Documented; App token when branch protection lands                                                    |
