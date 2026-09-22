# SSE auth, session revocation, and the multi-frontend seam

Written 2026-09-23. Closes the SSE item recorded as out of scope in
react-boilerplate's `docs/superpowers/decisions/2026-09-22-open-items.md` §6, plus two gaps
found by auditing it, plus the seam needed before a second frontend exists.

Three pieces. They are separable and ship in the order given; each step is independently
deployable and backward compatible.

---

## 0. Why the obvious fix was rejected

The recorded fix was "a short-TTL ticket issued by POST" — the access token stops riding in
the stream URL and a single-use ticket rides there instead. That was designed in full and then
dropped, for two reasons.

**The house already solved this.** `Consequential/core` streams SSE from
`POST /api/v1/chat/messages` behind its ordinary `requireAuthentication`, and
`Consequential/pulse/src/http/sse.http.ts` consumes it with `fetch` + `ReadableStream`. Its
own comment states the reason:

> _"Uses fetch + ReadableStream rather than EventSource because we need to send the
> Authorization header and POST a body — neither is supported by EventSource."_

**A ticket keeps a credential in the URL; a header removes it.** A ticket is only _worth
less_ when leaked. A `fetch` with `Authorization` puts nothing in the URL at all, needs no new
endpoint, no new token purpose, no sweeper, and no round trip per reconnect.

It is also the only option that survives every frontend. An embedded Shopify app runs in a
third-party iframe where cookies are blocked outright — which is exactly why
`Consequential/core/src/middlewares/require-shopify-session-token.middleware.ts` reads App
Bridge's session token from `Authorization: Bearer`. **Cookie auth for the stream would have
been a dead end the first time a Shopify app appeared.**

---

## 1. Piece 3 — the multi-frontend seam

Ordered first because it changes the constraints the other two work under.

### The cookie does not change

The instinct with subdomains is `domain=.example.com`. **That is a downgrade and this spec
rejects it.** Keep the refresh cookie host-only on the API domain.

It still works cross-origin, because cookies attach based on the **request URL**, not the
calling page. `app.example.com` doing
`fetch('https://api.example.com/...', { credentials: 'include' })` matches a host-only cookie
on `api.example.com`. `SameSite=Strict` permits it because SameSite keys on the **registrable
domain** — both are `example.com`, so the request is same-_site_ even though it is
cross-_origin_.

Domain-scoping would expose the refresh token to every subdomain, including the Shopify app
and any future marketing site, and buys nothing.

So: `Path=/api/v1/auth`, `SameSite=Strict`, `httpOnly`, host-only — **all unchanged**.

**Including the documented exception.** `setOAuthRefreshTokenCookie` sets `sameSite: 'lax'`
for the Google callback alone, because the browser arrives at `handleGoogleCallback` via a
top-level navigation redirected from `accounts.google.com` — genuinely cross-site — and a
`'strict'` cookie would be withheld on that request and the next one. That exception stays
exactly as written. Subdomains make the _second_ hop (to `WEB_URL`) same-site, which is
strictly better than a split-domain deployment, but the Google hop is cross-site regardless.

### CORS

Modelled on `Consequential/core/src/configs/cors/cors.config.ts`.

| Option                 | Value                                                                                 | Why                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `origin`               | callback: allow when `!origin`, or `origin === WEB_URL`, or in `CORS_ALLOWED_ORIGINS` | Never `*` — it is incompatible with `credentials: true`                             |
| `credentials`          | `true`                                                                                | The refresh cookie must survive cross-origin                                        |
| `allowedHeaders`       | `Authorization`, `Content-Type`, `Last-Event-ID`                                      | `Last-Event-ID` is required by Piece 2; omitting it silently kills replay           |
| `exposedHeaders`       | the token-state headers the client reads                                              | Unexposed headers are invisible to JS                                               |
| `maxAge`               | `600`                                                                                 | Chrome caps preflight caching at 600s; Firefox at 86400. 600 is the one both honour |
| `optionsSuccessStatus` | `204`                                                                                 | As Consequential                                                                    |

**`WEB_URL` must always be allowed, and `!origin` must always pass.** This is not a
convenience — it was measured. Vite's dev proxy **forwards the browser's `Origin` header**:

```
POST through localhost:5173  ->  { "origin": "http://localhost:5173", "host": "localhost:4040" }
GET  through localhost:5173  ->  { "origin": null,                    "host": "localhost:4040" }
```

So an allowlist that defaults to empty and rejects any present origin **breaks every login
POST in development**, while GETs keep working — a failure that looks like a login bug, not a
CORS bug. Allowing `WEB_URL` (already in `.env`) makes CORS a genuine no-op for both the
current same-origin deployment and local development.

### Testing it where it is real

`pnpm dev` proxies `/api`, so development is always same-origin and **CORS is never
exercised**. That is the same trap that cost an afternoon on the SSE close propagation: a dev
proxy hid the real behaviour, and the first honest test was the production image.

CORS is therefore tested in react-boilerplate's **`nginx` Playwright project**, which already
serves the real image. Two cases: a disallowed origin whose preflight fails, and an allowed
origin that succeeds with credentials.

**Also verify there**: `OPTIONS /api/v1/notifications/stream` returns 204 promptly. That
location carries `proxy_buffering off` and `proxy_read_timeout 24h`; the `cors` middleware
answers the preflight in Express, but nginx has to route it there rather than hold it.

---

## 2. Piece 1 — the stream over fetch, not EventSource

### Server

`GET /api/v1/notifications/stream` moves **behind `requireAuth`** and stops being the
exception `notification.routes.ts` documents at length. `authenticateStreamRequest` and its
entire `?token=` path are **deleted**, not adapted.

The route stays `GET` — unlike Consequential's chat stream it carries no body — so
**`nginx.conf` needs no change**. Its SSE location comment must be rewritten: the
query-stripping log format stays (harmless, and still right for any future query), but its
stated reason — a live access token in the request line — no longer exists.

### Client

Port `parseSseStream` from `Consequential/pulse/src/http/sse.http.ts`: roughly thirty lines
reading `body.getReader()` and splitting on `\n\n`. **No new dependency** — the house
hand-rolled it rather than take `fetch-event-source`, and so do we.

`use-notifications.ts:123` becomes a `fetch` with `Authorization: Bearer`. The existing
hand-rolled reconnect and backoff stay exactly as they are — they already override the
server's `retry:` directive deliberately, so nothing is lost by leaving `EventSource` behind.

The 401 path follows the house pattern verbatim:

> _"Raw fetch bypasses the axios response interceptor, so an expired access token must be
> refreshed here: shared single-flight refresh, one retry."_

which is `ensureSession()` in this codebase.

**No cookie is involved.** The stream authenticates by header, so only `/auth/refresh` ever
sends `credentials: 'include'`. The refresh cookie's blast radius stays one endpoint.

### What this recovers

The server already implements `Last-Event-ID` replay — tests at
`tests/integration/api/notification-stream.test.ts:436`, `:505`, `:583` — but `EventSource`
cannot send the header, so **that code has never run in production**. `fetch` can send it.
This is why `Last-Event-ID` is in `allowedHeaders` above.

---

## 3. Piece 2 — access tokens die at logout

### The gap

`logout` calls `revokeRefreshToken`, which revokes the **whole session family** via
`revokeAllForSession`. The refresh side is clean. But the access token carries only `{ sub }`,
nothing checks a session, and so **it keeps working for up to `ACCESS_TOKEN_TTL` (15m) after
logout**.

Both reference codebases have this same gap — they are stateless verifies. Closing it puts
this codebase ahead of both, not level with them.

### The change

**Add `sid` to `AccessTokenPayload`.** Today `{ sub }`; both `Ofluence/core` and
`Consequential/core` carry `{ userId, email, sessionId }`. This is the house convention.

**A Redis denylist keyed by session**, TTL = `ACCESS_TOKEN_TTL`, written from
`revokeAllForSession` — the single choke point that `logout`, password change **and
refresh-token reuse detection** all already pass through. Closing one place closes all three.

The TTL is the point: an entry only has to outlive the tokens it invalidates, so it expires
exactly when it stops mattering. Memory is bounded by logouts-per-15-minutes and no sweeper is
needed. Redis is already the store for rate limiting and passport sessions (`getRedis()`).

The alternative — asking the DB "does a live refresh token exist for this `sid`?" — needs no
new store but adds a second DB read per request and couples access-token validity to
refresh-row state. Rejected on cost.

### Two consumers, not one

This is the part most easily got wrong.

1. **`requireAuth`** — checks the denylist after verifying the signature. Covers every
   ordinary request, and the stream **at connect**.
2. **`streamNotifications`' heartbeat callback** (`notification-stream.controller.ts:276`) —
   today it only writes a comment frame. It must also check the denylist and close the
   connection when the session is gone.

**Without the second, an open stream survives logout indefinitely** and the audit's gaps stay
open while this spec claims they are closed. `requireAuth` runs once, at connect; nginx allows
a 24-hour read timeout. The heartbeat is the only thing that recurs.

Because that check reloads the user, it also closes the case where a **deactivated** account
keeps an open stream — which `authenticateStreamRequest`'s current comment wrongly claims is
already handled ("outstanding SSE connections stop working the same way its outstanding bearer
tokens do" — true for new connections, false for open ones).

### Honest limits

**The denylist is best-effort. The database remains the source of truth for the refresh side.**

- **Tokens issued before deploy carry no `sid`.** Policy: treat a token without `sid` as
  unrevocable and accept it until it expires, for one release only, then reject. Stated so
  nobody discovers it as a mystery 401.
- **A Redis restart or `FLUSHALL` drops every entry.** There is no DB fallback, because the
  database does not know a given access token exists. Add a `jti` alongside `sid` so an
  accepted-after-flush token can at least be identified in logs.
- Logout is therefore **much** tighter, not airtight. The worst case returns to today's
  behaviour: a 15-minute window.

---

## 4. Deployment order

Each step deploys alone and is backward compatible.

1. **Express** — CORS (`WEB_URL` allowed, so a no-op), `sid` + `jti` in the token, denylist in
   `requireAuth` and the heartbeat, stream accepts **either** a Bearer header **or** the
   legacy `?token=`.
2. **React** — stream switches to `fetch` + Bearer.
3. **Express** — delete the `?token=` path and `authenticateStreamRequest`.

Skipping the dual-accept in step 1 breaks whichever repo ships second.

## 5. Deferred — recorded so it is not rediscovered

From the audit of 2026-09-22, deliberately out of scope here:

- **No rate limiter on `/stream`.** Fourteen limiters exist elsewhere; this route has none,
  and the client reconnects under backoff.
- **No cap on concurrent streams per user.** Each holds an emitter listener and a heartbeat
  timer.
- **React Native cannot use `parseSseStream`.** RN's `fetch` is XHR-backed and
  `response.body` is not a `ReadableStream`. Mobile needs an XHR-based SSE client — which
  _can_ set headers, so the Bearer design still holds; only the parser does not port.
- **Multi-pod fan-out.** The notification emitter is in-process by design; Redis Pub/Sub is
  the documented upgrade path. Unchanged by this spec.

## 6. Acceptance

1. Stream authenticates by `Authorization` header; no credential appears in any URL.
2. `authenticateStreamRequest` and the `?token=` branch are deleted.
3. `Last-Event-ID` reaches the server from the browser, and the existing replay tests cover a
   real round trip rather than a synthetic one.
4. Logging out invalidates outstanding access tokens immediately, proven by a test that
   logs out and asserts the next request 401s.
5. Logging out **closes an open stream within one heartbeat interval**, proven by a test.
6. CORS: an allowed origin succeeds with credentials, a disallowed origin's preflight fails,
   and `OPTIONS` on the SSE location returns 204 promptly — all asserted through the nginx
   image, not the dev proxy.
7. Existing suites stay green in both repos.
