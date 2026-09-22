# Multi-Frontend CORS Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second frontend on a sibling subdomain call this API, without changing the refresh cookie or breaking the current same-origin deployment.

**Architecture:** One `cors` middleware mounted ahead of the API router, driven by an origin allowlist that always admits `WEB_URL` and same-origin requests. The refresh cookie is deliberately untouched — host-only, `Path=/api/v1/auth`, `SameSite=Strict` — because cookies attach by request URL and `SameSite` keys on the registrable domain, so a sibling subdomain already works.

**Tech Stack:** Express 5, `cors`, Zod-validated env (`src/configs/env.config.ts`), Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-sse-auth-and-multi-frontend-design.md` §1

## Global Constraints

- **The refresh cookie does not change.** No `domain` attribute, `Path=/api/v1/auth`, `SameSite=Strict`, `httpOnly`. Adding `domain=.example.com` is explicitly rejected by the spec.
- **`setOAuthRefreshTokenCookie`'s `sameSite: 'lax'` exception stays exactly as written.**
- **Never `origin: '*'`** — incompatible with `credentials: true`.
- **`!origin` must pass** (same-origin requests send no `Origin`).
- **`WEB_URL` must always be allowed.** Measured: Vite's dev proxy forwards `Origin: http://localhost:5173` on POST but not on GET, so an empty allowlist breaks login in development while GETs keep working.
- `maxAge: 600` — Chrome caps preflight caching at 600s.
- Gate is 0 errors and 0 warnings: `pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test`.
  **There is no `pnpm typecheck` in this repo** — `pnpm lint` is `eslint . && tsc -p tsconfig.typecheck.json --noEmit`,
  so typecheck is already inside it. Prettier is the separate `pnpm format:check`, which is repo-wide and currently
  fails only on pre-existing untracked `.claude/worktrees/` and `.vitest/`; formatting of committed files is handled
  by lint-staged's `prettier --write` pre-commit hook, so do not gate on it.

---

## File Structure

| File                                            | Responsibility                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/configs/env.config.ts`                     | Add `CORS_ALLOWED_ORIGINS` (optional, comma-separated)                                                                      |
| `src/utilities/origin.utilities.ts`             | **New.** Parse the list, expose `isAllowedOrigin(origin)` — the single source of truth for "what counts as a client origin" |
| `src/configs/cors.config.ts`                    | **New.** The `CorsOptions` object                                                                                           |
| `src/app.ts`                                    | Mount `cors(corsOptions)` before the API router                                                                             |
| `.env.example`                                  | Document `CORS_ALLOWED_ORIGINS`                                                                                             |
| `tests/unit/utilities/origin.utilities.test.ts` | **New.** Allowlist logic                                                                                                    |
| `tests/integration/api/cors.test.ts`            | **New.** Real requests through `createApp()`                                                                                |

---

### Task 1: The origin allowlist

**Files:**

- Modify: `src/configs/env.config.ts`
- Create: `src/utilities/origin.utilities.ts`
- Create: `tests/unit/utilities/origin.utilities.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `getEnv()` from `@/configs/env.config`.
- Produces: `isAllowedOrigin(origin: string | undefined): boolean`, used by Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/utilities/origin.utilities.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('isAllowedOrigin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function load(webUrl: string, allowed?: string) {
    vi.doMock('@/configs/env.config', () => ({
      getEnv: () => ({ WEB_URL: webUrl, CORS_ALLOWED_ORIGINS: allowed }),
    }))
    return (await import('@/utilities/origin.utilities')).isAllowedOrigin
  }

  it('allows a request with no Origin header, which is what same-origin sends', async () => {
    const isAllowedOrigin = await load('http://localhost:5173')
    expect(isAllowedOrigin(undefined)).toBe(true)
  })

  it('always allows WEB_URL, even when the allowlist is empty', async () => {
    // Load-bearing: Vite's dev proxy forwards Origin on POST, so without this
    // every login in development fails CORS while GETs keep working.
    const isAllowedOrigin = await load('http://localhost:5173')
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
  })

  it('allows each entry in CORS_ALLOWED_ORIGINS', async () => {
    const isAllowedOrigin = await load(
      'https://app.example.com',
      'https://admin.example.com, https://shop.example.com'
    )
    expect(isAllowedOrigin('https://admin.example.com')).toBe(true)
    expect(isAllowedOrigin('https://shop.example.com')).toBe(true)
  })

  it('rejects anything else', async () => {
    const isAllowedOrigin = await load('https://app.example.com', 'https://admin.example.com')
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
  })

  it('rejects a lookalike that merely shares a suffix', async () => {
    const isAllowedOrigin = await load('https://app.example.com')
    expect(isAllowedOrigin('https://app.example.com.evil.test')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/unit/utilities/origin.utilities.test.ts
```

Expected: FAIL — `Cannot find module '@/utilities/origin.utilities'`.

- [ ] **Step 3: Add the env var**

In `src/configs/env.config.ts`, add to the schema object alongside `TRUST_PROXY`:

```ts
  // Extra browser origins allowed to call this API, comma-separated, e.g.
  // "https://admin.example.com,https://shop.example.com". WEB_URL is ALWAYS
  // allowed and does not need listing. Same-origin requests send no Origin
  // header at all and are always allowed. Never a wildcard: `cors` refuses
  // `*` together with `credentials: true`, which this API needs for the
  // refresh cookie.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
```

- [ ] **Step 4: Write the utility**

Create `src/utilities/origin.utilities.ts`:

```ts
import { getEnv } from '@/configs/env.config'

/**
 * The one definition of "an origin this API will talk to".
 *
 * Exact string equality against a fixed set — never a suffix or regex match.
 * `https://app.example.com.evil.test` ENDS WITH nothing useful, but a
 * carelessly written `endsWith('.example.com')` would accept
 * `https://evil-example.com` and a sloppy regex would accept worse.
 * @param origin - The request's `Origin` header, or undefined when it has none.
 * @returns True when the request may proceed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // No Origin header at all. That is what a same-origin request sends, and
  // also what a non-browser client (curl, a mobile app, a server-to-server
  // call) sends. CORS is a browser mechanism; there is nothing to enforce.
  if (!origin) return true

  const env = getEnv()

  // WEB_URL is always allowed and never needs listing. This is not a
  // convenience: Vite's dev proxy FORWARDS the browser's Origin header on
  // POST (measured — GET arrives with none), so an allowlist that defaulted
  // to empty would fail every login in development while GETs kept working.
  if (origin === env.WEB_URL) return true

  return parseOriginList(env.CORS_ALLOWED_ORIGINS).has(origin)
}

/**
 * Split a comma-separated origin list, trimming blanks.
 * @param raw - The raw env value, or undefined.
 * @returns The set of origins it names.
 */
function parseOriginList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm exec vitest run tests/unit/utilities/origin.utilities.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Document the env var**

Append to `.env.example`, after `TRUST_PROXY`:

```
# Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.
CORS_ALLOWED_ORIGINS=
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test
git add src/configs/env.config.ts src/utilities/origin.utilities.ts tests/unit/utilities/origin.utilities.test.ts .env.example
git commit -m "feat: add the client origin allowlist"
```

---

### Task 2: Mount CORS

**Files:**

- Create: `src/configs/cors.config.ts`
- Modify: `src/app.ts:48` (before `app.use(requestId)`)
- Create: `tests/integration/api/cors.test.ts`
- Modify: `package.json` (add `cors`, `@types/cors`)

**Interfaces:**

- Consumes: `isAllowedOrigin` from Task 1.
- Produces: `corsOptions: CorsOptions`, exported from `@/configs/cors.config`.

- [ ] **Step 1: Install the dependency**

```bash
pnpm add cors && pnpm add -D @types/cors
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/api/cors.test.ts`:

```ts
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'

const app = createApp()

describe('CORS', () => {
  it('answers a preflight from an allowed origin with credentials enabled', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    // Echoed, never '*': the CORS spec forbids a wildcard with credentials,
    // and browsers reject the response outright if both appear.
    expect(response.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('allows Last-Event-ID, without which SSE replay silently never fires', async () => {
    const response = await request(app)
      .options('/api/v1/notifications/stream')
      .set('Origin', process.env.WEB_URL ?? 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,last-event-id')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'last-event-id'
    )
  })

  it('does not grant access to an origin that is not allowed', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')

    // `cors` answers the preflight but withholds the grant header, which is
    // what makes the browser block it. Asserting the HEADER is absent is the
    // real check — asserting a status code here proves nothing.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('leaves same-origin requests, which send no Origin, completely alone', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm exec vitest run tests/integration/api/cors.test.ts
```

Expected: FAIL — no `access-control-allow-credentials` header, because nothing mounts CORS yet.

- [ ] **Step 4: Write the config**

Create `src/configs/cors.config.ts`:

```ts
import type { CorsOptions } from 'cors'
import { isAllowedOrigin } from '@/utilities/origin.utilities'

/**
 * How this API answers a browser's cross-origin questions.
 *
 * `credentials: true` is the reason `origin` can never be `'*'`: the CORS
 * spec forbids the pair, and a browser discards the response rather than
 * warning about it.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Never pass an Error for a disallowed origin. Doing so turns a browser
    // CORS block — which is the correct, quiet outcome — into a 500 in this
    // API's own error handler and logs. `false` withholds the grant header,
    // which is exactly what blocks the browser.
    callback(null, isAllowedOrigin(origin))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  // `Last-Event-ID` is load-bearing. The SSE stream's replay-on-reconnect is
  // implemented server-side and tested, but a cross-origin browser cannot
  // send the header unless it is named here — and the failure is silent:
  // replay simply never happens.
  allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
  // Unexposed response headers are invisible to JavaScript. The client reads
  // these to tell an expired token from an invalid one.
  exposedHeaders: ['X-Request-Id'],
  // Chrome caps preflight caching at 600s and Firefox at 86400; 600 is the
  // value both honour. Without it, every cross-origin call preflights,
  // because `Authorization` is not a CORS-safelisted header.
  maxAge: 600,
  optionsSuccessStatus: 204,
}
```

- [ ] **Step 5: Mount it**

In `src/app.ts`, immediately before `app.use(requestId)` (line 48):

```ts
// BEFORE requestId and the body parsers: a preflight is an OPTIONS request
// that must be answered and ended here, not carried through the rest of
// the stack. Mounting it later means preflights allocate a request id and
// walk middleware that has nothing to say about them.
app.use(cors(corsOptions))
```

Add the imports at the top of the file:

```ts
import cors from 'cors'
import { corsOptions } from '@/configs/cors.config'
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm exec vitest run tests/integration/api/cors.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Verify nothing else moved**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm test
```

Expected: all green. The existing suites are the real check that mounting CORS is a no-op for the current deployment.

- [ ] **Step 8: Commit**

```bash
git add src/configs/cors.config.ts src/app.ts tests/integration/api/cors.test.ts package.json pnpm-lock.yaml
git commit -m "feat: allow a second frontend to call this API"
```

---

## Self-Review

**Spec coverage (§1):** cookie unchanged — no task touches it, which is the point, and it is stated in Global Constraints. CORS table — Task 2 step 4, every row. `WEB_URL` always allowed and `!origin` passing — Task 1, two dedicated tests. `maxAge: 600` with the Chrome cap cited — Task 2 step 4.

**Deliberately NOT here:** testing CORS through the nginx image. That belongs to react-boilerplate's `nginx` Playwright project and is Task 4 of the stream-transport plan, because it needs the production image built. These supertest cases prove the middleware's logic; they cannot prove nginx routes an `OPTIONS` to it.

**Placeholder scan:** no TBDs; every step carries runnable code.

**Type consistency:** `isAllowedOrigin(origin: string | undefined): boolean` is defined in Task 1 step 4 and consumed in Task 2 step 4 with the same signature. `corsOptions` is `CorsOptions` from `cors` in both its definition and its use.
