# Stream Transport Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the access token out of the notification stream's URL by authenticating it with an `Authorization` header, which `EventSource` cannot send and `fetch` can.

**Architecture:** The stream stops being an auth special case and moves behind `requireAuth`. The client stops using `EventSource` and reads the response body as a stream, porting `parseSseStream` from `Consequential/pulse/src/http/sse.http.ts` — the house pattern, hand-rolled rather than taking a dependency. Ships in three deployable steps so neither repo can break the other.

**Tech Stack:** Express 5, React 19, Vitest + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-sse-auth-and-multi-frontend-design.md` §2

**Spans two repositories.** Tasks 1 and 4 are `express-boilerplate`; Tasks 2 and 3 are `react-boilerplate` at `~/Mahaverick/react-boilerplate`.

## Global Constraints

- **Deployment order is not optional.** Task 1 (accept both) ships and deploys before Task 2 (client switches), which ships before Task 3 (drop the old path). Skipping the dual-accept breaks whichever repo deploys second.
- **The route stays `GET`.** It carries no body, so `nginx.conf` needs no change.
- **No new dependency.** `parseSseStream` is ~30 lines; the house did not take `fetch-event-source` and neither do we.
- **The existing reconnect and backoff stay.** The hook already overrides the server's `retry:` directive deliberately; leaving `EventSource` costs nothing.
- **React Native cannot use this parser** — RN's `fetch` is XHR-backed and `response.body` is not a `ReadableStream`. Out of scope; noted in the spec's Deferred section.
- Express gate: `pnpm exec eslint . --max-warnings 0`. React gate: the same, plus `pnpm lint` (prettier) and `pnpm test`.

---

## File Structure

| Repo    | File                                                | Responsibility                                                             |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| express | `src/controllers/notification-stream.controller.ts` | Accept a Bearer header; later, stop accepting `?token=`                    |
| express | `src/routes/notification.routes.ts`                 | Move `/stream` behind `requireAuth` (Task 3)                               |
| react   | `src/http/sse.ts`                                   | **New.** `parseSseStream` — the only module that knows the SSE wire format |
| react   | `src/hooks/use-notifications.ts:123`                | `fetch` + Bearer in place of `new EventSource(...)`                        |
| react   | `e2e/nginx/cors.test.ts`                            | **New.** CORS and preflight, through the real image                        |

---

### Task 1 (express): Accept a Bearer header as well as `?token=`

**Files:**

- Modify: `src/controllers/notification-stream.controller.ts:72-92` (`authenticateStreamRequest`)
- Test: `tests/integration/api/notification-stream.test.ts`

**Interfaces:**

- Produces: `GET /api/v1/notifications/stream` authenticating from **either** `Authorization: Bearer <token>` or `?token=`. Task 2 relies on the header path; Task 3 removes the query path.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/api/notification-stream.test.ts`, alongside the existing connect tests:

```ts
it('opens a stream from an Authorization header, with nothing in the URL', async () => {
  const stream = await openStream({ header: `Bearer ${accessToken}` })
  expect(stream.status).toBe(200)
  expect(stream.headers['content-type']).toContain('text/event-stream')
})

it('still opens a stream from ?token=, so an old bundle keeps working during the rollout', async () => {
  const stream = await openStream({ query: accessToken })
  expect(stream.status).toBe(200)
})

it('prefers the header when both are present', async () => {
  const stream = await openStream({ header: `Bearer ${accessToken}`, query: 'not-a-token' })
  expect(stream.status).toBe(200)
})
```

Extend that file's existing stream-opening helper to take `{ header?, query? }` rather than writing a second one.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/integration/api/notification-stream.test.ts -t 'Authorization header'
```

Expected: FAIL with 401 — only `?token=` is read today.

- [ ] **Step 3: Read the header first, the query second**

Replace the token extraction at the top of `authenticateStreamRequest` (`:73-76`):

```ts
// Header FIRST. `EventSource` cannot set one, which is the whole reason
// this endpoint ever read a query parameter — but the client now uses
// `fetch`, which can. The query path is kept for exactly one release so an
// old bundle keeps working while both repos deploy; Task 3 deletes it.
const header = request.header('Authorization')
const fromHeader = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
const fromQuery = typeof request.query.token === 'string' ? request.query.token : undefined
const token = fromHeader || fromQuery

if (!token) {
  throw new HttpError('Missing access token', 401)
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm exec vitest run tests/integration/api/notification-stream.test.ts
```

Expected: PASS — the three new tests plus the existing fourteen.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm typecheck && pnpm test
git add src/controllers/notification-stream.controller.ts tests/integration/api/notification-stream.test.ts
git commit -m "feat: let the notification stream authenticate from a Bearer header"
```

**Deploy this before starting Task 2.**

---

### Task 2 (react): Stream over fetch

**Repo:** `~/Mahaverick/react-boilerplate`

**Files:**

- Create: `src/http/sse.ts`
- Create: `src/http/sse.test.ts`
- Modify: `src/hooks/use-notifications.ts:118-152`

**Interfaces:**

- Produces: `parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>` where `SseEvent = { id?: string; event?: string; data: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/http/sse.test.ts`:

```tsx
import { describe, expect, it } from 'vitest'
import { parseSseStream } from '@/http/sse'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('parseSseStream', () => {
  it('yields one event per frame', async () => {
    const events = []
    for await (const event of parseSseStream(streamOf('data: one\n\ndata: two\n\n'))) {
      events.push(event)
    }
    expect(events.map((e) => e.data)).toEqual(['one', 'two'])
  })

  it('reassembles a frame split across chunks', async () => {
    // The case a naive split-per-chunk parser gets wrong, and the reason the
    // buffer survives across reads.
    const events = []
    for await (const event of parseSseStream(streamOf('data: sp', 'lit\n\n'))) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('split')
  })

  it('carries id and event name, which is what makes replay work', async () => {
    const events = []
    for await (const event of parseSseStream(
      streamOf('id: 42\nevent: notification\ndata: x\n\n')
    )) {
      events.push(event)
    }
    expect(events[0]).toMatchObject({ id: '42', event: 'notification', data: 'x' })
  })

  it('skips a heartbeat comment without yielding an event', async () => {
    const events = []
    for await (const event of parseSseStream(streamOf(': ping\n\ndata: real\n\n'))) {
      events.push(event)
    }
    expect(events.map((e) => e.data)).toEqual(['real'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm test --run src/http/sse.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

Create `src/http/sse.ts`:

```ts
/** One parsed SSE frame. */
export interface SseEvent {
  id?: string
  event?: string
  data: string
}

/**
 * Parse SSE frames out of a `fetch` response body.
 *
 * Ported from Consequential's `pulse/src/http/sse.http.ts`, which exists for
 * the same reason this does: `EventSource` cannot send an `Authorization`
 * header, so the stream is read from `fetch` instead — and then something
 * has to do the framing `EventSource` was doing for us.
 *
 * The buffer OUTLIVES each read deliberately. A frame is not guaranteed to
 * arrive whole in one chunk, and splitting per chunk drops the boundary case
 * silently.
 * @param body - The response body stream.
 * @yields Each complete frame, in order.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const frames = buffer.split('\n\n')
    // The last element is an incomplete frame, or ''. Keep it for next read.
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const parsed = parseFrame(frame)
      if (parsed) yield parsed
    }
  }
}

/**
 * Turn one raw frame into an event, or nothing.
 * @param frame - The frame text, without its trailing blank line.
 * @returns The event, or undefined for a comment or a frame with no data.
 */
function parseFrame(frame: string): SseEvent | undefined {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    // A comment. The server's heartbeat is `: ping`, and it must not surface
    // as an event — it exists to keep proxies from reaping an idle socket.
    if (line.startsWith(':')) continue
    if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }

  if (data.length === 0) return undefined
  return { id, event, data: data.join('\n') }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm test --run src/http/sse.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Switch the hook to fetch**

In `src/hooks/use-notifications.ts`, replace the `connect` function's `EventSource` construction (`:118-152`) with a fetch. Keep `scheduleReconnect`, `onNotification`, the backoff and the cleanup **exactly** as they are — only the transport changes.

```ts
const connect = (token: string) => {
  if (cancelled) return
  const controller = new AbortController()
  abort = controller

  void (async () => {
    try {
      const response = await fetch(`${API_PREFIX}/notifications/stream`, {
        headers: {
          // The whole point of this change: the credential travels in a
          // header, not the URL, so it never reaches browser history,
          // a Referer, or any log that records request lines.
          Authorization: `Bearer ${token}`,
          // EventSource sent this for us and could not be told not to;
          // fetch must send it explicitly. The server has implemented
          // replay all along — this is the first time it can fire.
          ...(lastEventId.current ? { 'Last-Event-ID': lastEventId.current } : {}),
        },
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`stream failed: ${response.status}`)
      }
      refetchList()

      for await (const event of parseSseStream(response.body)) {
        if (event.id) lastEventId.current = event.id
        if (event.event === NOTIFICATION_EVENT) onNotification()
      }
      // The generator ending means the server closed the connection.
      if (!cancelled) scheduleReconnect(token)
    } catch (error) {
      if (controller.signal.aborted || cancelled) return
      scheduleReconnect(token)
    }
  })()
}
```

Add near the other refs:

```ts
const lastEventId = useRef<string | undefined>(undefined)
```

and declare `let abort: AbortController | null = null` beside `source`, replacing `source?.close()` in the cleanup with `abort?.abort()`.

- [ ] **Step 6: Run the hook's tests**

```bash
pnpm test --run src/hooks/use-notifications.test.tsx
```

Expected: FAIL initially — those tests mock `EventSource`. Rewrite each to mock `fetch` returning a `ReadableStream`, using `streamOf` from `src/http/sse.test.ts` as the model. **Do not delete a test to make it pass**; each one asserts a reconnect or delivery behaviour that still holds.

- [ ] **Step 7: Verify everything**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm lint && pnpm typecheck && pnpm test --run
```

Expected: green, with no fewer tests than before.

- [ ] **Step 8: Commit**

```bash
git add src/http/sse.ts src/http/sse.test.ts src/hooks/use-notifications.ts src/hooks/use-notifications.test.tsx
git commit -m "feat: read the notification stream over fetch, not EventSource"
```

**Deploy this before starting Task 3.**

---

### Task 3 (express): Delete the query-parameter path

**Files:**

- Modify: `src/controllers/notification-stream.controller.ts` — delete `authenticateStreamRequest`
- Modify: `src/routes/notification.routes.ts:47-49`
- Modify: `nginx.conf` (comment only) in `~/Mahaverick/react-boilerplate`

- [ ] **Step 1: Move the route behind requireAuth**

In `src/routes/notification.routes.ts`, delete the standalone `/stream` registration at `:47` and move it below `router.use(requireAuth)`:

```ts
router.use(requireAuth)

router.get('/stream', streamNotifications)
router.get('/', listNotifications)
```

Rewrite that file's header comment: `/stream` is no longer an exception, and the paragraph explaining why it is registered before `requireAuth` is now wrong.

- [ ] **Step 2: Delete the bespoke authentication**

Remove `authenticateStreamRequest` entirely and take the user id from `request.user`, which `requireAuth` has already populated. Keep the session capture from the revocation plan's Task 5 — read it from the verified payload that `requireAuth` attaches, or re-verify once at connect if the middleware does not expose it.

- [ ] **Step 3: Update the tests**

The `?token=` tests from Task 1 must now assert a **401**, and the "rejects a connection with no token" case is now `requireAuth`'s 401 rather than the controller's. Keep both; change the expectation, and note in each that the query path was removed deliberately.

- [ ] **Step 4: Fix the nginx comment**

In `~/Mahaverick/react-boilerplate/nginx.conf`, the SSE location's long comment explains that the access log is stripped because a live token rides in the request line. Keep the `stream_nolog` format and the `error_log crit` line — both are still correct for any future query string — but replace the reasoning: the token no longer travels there, and the stripping is now defence in depth rather than a fix for a known leak.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec eslint . --max-warnings 0 && pnpm typecheck && pnpm test
git add src/controllers/notification-stream.controller.ts src/routes/notification.routes.ts tests/integration/api/notification-stream.test.ts
git commit -m "feat: authenticate the stream only by header"
```

---

### Task 4 (react): Prove CORS through the real image

**Repo:** `~/Mahaverick/react-boilerplate`

The unit tests in the CORS plan prove the middleware's logic. They cannot prove nginx routes an `OPTIONS` to it, and `pnpm dev` proxies `/api` so development is same-origin and never exercises CORS at all. That is the exact trap that cost an afternoon on the SSE close propagation.

**Files:**

- Create: `e2e/nginx/cors.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { expect, test } from '@playwright/test'
import { API_ORIGIN, apiIsReady } from '../live/helpers'

const APP_ORIGIN = process.env.E2E_NGINX_ORIGIN ?? 'http://localhost:8088'

test.skip(process.env.E2E_LIVE !== '1', 'needs the nginx container — run pnpm test:e2e:nginx')

test.beforeAll(async () => {
  if (!(await apiIsReady())) throw new Error(`No API at ${API_ORIGIN}`)
})

test('preflights the SSE stream promptly, rather than holding it open', async ({ request }) => {
  // That location carries `proxy_buffering off` and `proxy_read_timeout 24h`.
  // A preflight must still be answered by Express and returned at once.
  const started = Date.now()
  const response = await request.fetch(`${APP_ORIGIN}/api/v1/notifications/stream`, {
    method: 'OPTIONS',
    headers: {
      Origin: APP_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,last-event-id',
    },
  })

  expect(response.status()).toBe(204)
  expect(Date.now() - started).toBeLessThan(5000)
  const allowed = response.headers()['access-control-allow-headers']?.toLowerCase() ?? ''
  expect(allowed).toContain('last-event-id')
})

test('withholds the grant header from an origin that is not allowed', async ({ request }) => {
  const response = await request.fetch(`${APP_ORIGIN}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  })
  expect(response.headers()['access-control-allow-origin']).toBeUndefined()
})
```

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e:nginx
```

Expected: PASS. A hang on the first test is the finding this task exists for — it would mean nginx is holding the preflight on the SSE location rather than passing it through.

- [ ] **Step 3: Commit**

```bash
git add e2e/nginx/cors.test.ts
git commit -m "test: prove CORS and the SSE preflight through the real image"
```

---

## Self-Review

**Spec coverage (§2):** stream behind `requireAuth` and the query path deleted — Tasks 1 and 3. Route stays GET, nginx unchanged but its comment corrected — Task 3 step 4. `parseSseStream` ported, no dependency — Task 2. `Last-Event-ID` finally reaching the server — Task 2 step 5, and asserted through nginx in Task 4. Deployment order — Global Constraints, restated at the end of Tasks 1 and 2.

**Placeholder scan:** clean. Task 3 steps 2 and 3 direct the implementer to adapt existing tests rather than supplying replacements verbatim, because those tests' fixtures live in a 26k file and reproducing them here would rot; both say exactly which expectation changes and why.

**Type consistency:** `parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>` and `SseEvent = { id?, event?, data }` are defined in Task 2 step 3 and consumed with those names in step 5. `NOTIFICATION_EVENT` is the constant the hook already imports.

**Cross-repo hazard:** Task 3 edits `nginx.conf`, which lives in react-boilerplate, from a plan whose other express tasks do not. Its commit therefore lands in a different repository from steps 1–3 of the same task — do not try to commit them together.
