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

| Option                 | Value                                                                                 | Why                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `origin`               | callback: allow when `!origin`, or `origin === WEB_URL`, or in `CORS_ALLOWED_ORIGINS` | Never `*` — it is incompatible with `credentials: true`                                                                       |
| `credentials`          | `true`                                                                                | The refresh cookie must survive cross-origin                                                                                  |
| `allowedHeaders`       | `Authorization`, `Content-Type`, `Last-Event-ID`                                      | `Last-Event-ID` is required by Piece 2; omitting it silently kills replay                                                     |
| `exposedHeaders`       | `X-Request-Id`                                                                        | Unexposed headers are invisible to JS; token state travels in the JSON error envelope's `code` field, which needs no exposure |
| `maxAge`               | `600`                                                                                 | Chrome caps preflight caching at 600s; Firefox at 86400. 600 is the one both honour                                           |
| `optionsSuccessStatus` | `204`                                                                                 | As Consequential                                                                                                              |

`X-Request-Id` (request-id.middleware.ts) is not in `allowedHeaders` and is not one of the
CORS-safelisted request headers, so a cross-origin client cannot send it today.
react-boilerplate's client (`src/http/client.ts:33`) only ever sends `Content-Type` and never
sends `X-Request-Id`, so nothing currently needs it — this is a trace-continuity gap for a
later frontend to close, not a blocker for this seam.

**`WEB_URL` must always be allowed, and `!origin` must always pass.** The reasoning is a
**production** cross-origin deployment (`app.example.com` calling `api.example.com`), not the
dev proxy. Under `pnpm dev`, the page and the request are both served from `localhost:5173`,
so the browser treats the call to the API as same-origin and applies no CORS check at all,
regardless of what the allowlist says — `callback(null, false)` only withholds the grant
header, it never rejects the request server-side. Vite's dev proxy does measurably **forward
the browser's `Origin` header** on POST:

```
POST through localhost:5173  ->  { "origin": "http://localhost:5173", "host": "localhost:4040" }
GET  through localhost:5173  ->  { "origin": null,                    "host": "localhost:4040" }
```

but that fact does not make development the case this rule protects — dev login works
identically with or without `WEB_URL` in the allowlist, because there is no cross-origin
boundary there for CORS to police. The rule earns its place in production: `app.example.com`
calling `api.example.com` on the sibling-subdomain deployment IS cross-origin, a browser DOES
enforce CORS there, and `WEB_URL` must be allowed for the primary frontend's own login POST to
succeed.

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
entire `?token=` path are **deleted**, not adapted — including the sid-less-token check it used
to run at connect. That check itself is not going away: it moves into a new, smaller function of
this controller's own, `requireSessionId`, now that `requireAuth` running ahead of this route
covers everything else `authenticateStreamRequest` used to. See Piece 2's "Three consumers, not
one" section below, whose plan predates this deletion and names the old function.

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

**A Redis denylist keyed by session**, TTL = `ACCESS_TOKEN_TTL`, written from **two**
revocation methods on `UserTokenRepository`:

- `revokeAllForSession`, the choke point `logout` and **refresh-token reuse detection** both
  pass through.
- `revokeAllForUser`, which **password reset** reaches instead (via `revokeAllSessions`). It is
  keyed on user id and holds no session id, so it must learn which sessions it revoked — a
  `RETURNING session_id` on the update — before it can deny them.

> **Corrected after implementation.** This section originally called `revokeAllForSession` "the
> single choke point that `logout`, password change **and** refresh-token reuse detection all
> already pass through", and concluded "closing one place closes all three". That was false, and
> the error was load-bearing: password reset does **not** pass through it. Left as written, the
> feature would have shipped with its most important path open — a user who resets their
> password because they believe they are compromised would have revoked their refresh tokens
> while every already-issued access token stayed valid for the rest of `ACCESS_TOKEN_TTL`. Found
> during execution and closed by an added Task 6.

The TTL is the point: an entry only has to outlive the tokens it invalidates. It runs from the
moment of denial and the token it denies was minted earlier, so the entry outlives that token
rather than matching it — the safe direction. Memory is bounded by revocations-per-15-minutes
and no sweeper is needed. Redis is already the store for rate limiting and passport sessions
(`getRedis()`).

The alternative — asking the DB "does a live refresh token exist for this `sid`?" — needs no
new store but adds a second DB read per request and couples access-token validity to
refresh-row state. Rejected on cost.

### Three consumers, not one

This is the part most easily got wrong.

1. **`requireAuth`** — checks the denylist after verifying the signature. Covers every
   ordinary request.
2. **`authenticateStreamRequest`** — the stream **at connect**. It needs its own check:
   `/stream` is registered on `notification.routes.ts` _before_ `router.use(requireAuth)`,
   so it never passes through that middleware at all.
3. **`streamNotifications`' heartbeat callback** — today it only writes a comment frame. It
   must also check the denylist and close the connection when the session is gone.

**Without the third, an open stream survives logout indefinitely** and the audit's gaps stay
open while this spec claims they are closed. The connect check runs once; nginx allows a
24-hour read timeout. The heartbeat is the only thing that recurs.

> **Corrected after implementation.** This section originally listed two consumers and said
> `requireAuth` covers "the stream **at connect**". It does not — `/stream` sits outside it.
> Found during execution and closed by Task 6.
>
> It also claimed the heartbeat check "reloads the user" and therefore closes the case where a
> **deactivated** account keeps an open stream. It does not reload the user; it consults the
> denylist only, and nothing in this codebase denies a session on deactivation. A deactivated
> account's _open_ stream keeps receiving frames until it closes for some other reason.
> Deactivation is caught on the next ordinary request, by `requireAuth`'s `findById` read.

> **Corrected again, later, by the stream-fetch-transport branch.** `authenticateStreamRequest`
> (item 2 above) no longer exists — that branch deleted it along with the `?token=` path. Its
> connect-time denylist check is not gone, it moved: `/stream` now sits **behind** `requireAuth`
> (`notification.routes.ts`), so `requireAuth`'s own denylist check (item 1) covers the stream's
> connect too, and item 2 as written here is obsolete rather than merely renamed. The one piece of
> `authenticateStreamRequest` that `requireAuth` does NOT cover — rejecting a sid-less token, which
> `requireAuth` deliberately tolerates everywhere else — lives on in a new function of its own,
> `requireSessionId` (`notification-stream.controller.ts`), called from `streamNotifications`
> immediately after `requireAuth` runs. So the stream's denylist coverage is now two consumers,
> not three: `requireAuth` (connect, and every other request) and the heartbeat below (the open
> connection). `requireSessionId` checks the `sid` claim's mere presence, not the denylist itself.

### Honest limits

**The denylist is best-effort. The database remains the source of truth for the refresh side.**

- **Tokens issued before deploy carry no `sid`.** Policy as built is deliberately
  **asymmetric**, which the original single-sentence policy did not anticipate:
  - `requireAuth` accepts a sid-less bearer token, treating it as unrevocable until it
    expires. That window is bounded by the token's own `exp`, so it is at most
    `ACCESS_TOKEN_TTL` — **fifteen minutes after deploy**, not a release cycle. Every token
    minted after deploy carries `sid`, including one minted by a refresh mid-session.
  - The stream's own connect-time check **rejects** a sid-less token outright, 401 — written here
    as `authenticateStreamRequest`, since renamed to `requireSessionId` when the
    stream-fetch-transport branch deleted `authenticateStreamRequest` (see the correction on
    "Three consumers, not one" above). It has to: the heartbeat's denial check can only act on a
    session id, so tolerating one here would grant a stream bounded by _connection lifetime_ — up
    to nginx's 24-hour read timeout — rather than by token expiry. The browser client answers a
    failed stream connect by refreshing and reconnecting, so the cost is one refresh and the path
    self-heals.

  Stated so nobody discovers either half as a mystery 401.

- **A Redis restart or `FLUSHALL` drops every entry.** There is no DB fallback, because the
  database does not know a given access token exists. Add a `jti` alongside `sid` so an
  accepted-after-flush token can at least be identified in logs.
- Logout is therefore **much** tighter, not airtight. The worst case returns to today's
  behaviour: a 15-minute window.

---

## 4. Deployment order

Each step deploys alone and is backward compatible.

> **Corrected after implementation.** All three steps below have since shipped, in this order —
> `sid`/`jti`, the denylist, and CORS from the session-revocation work; the `fetch` transport and
> the `?token=` deletion from stream-fetch-transport. Left in the original future tense below
> because the ordering constraint (step 1 before step 2, step 3 last) is still the fact worth
> keeping, not because the steps are still pending.

1. **Express** — CORS (`WEB_URL` allowed, so a no-op), `sid` + `jti` in the token, denylist in
   `requireAuth` and the heartbeat, stream accepts **either** a Bearer header **or** the
   legacy `?token=`.
2. **React** — stream switches to `fetch` + Bearer.
3. **Express** — delete the `?token=` path and `authenticateStreamRequest`.

Skipping the dual-accept in step 1 would have broken whichever repo shipped second.

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
2. `authenticateStreamRequest` and the `?token=` branch have been deleted — confirmed directly
   against `notification-stream.controller.ts` and `notification.routes.ts`, which no longer
   define or reference either.
3. `Last-Event-ID` reaches the server from the browser, and the existing replay tests cover a
   real round trip rather than a synthetic one.

   > **Partially met, recorded honestly rather than ticked.** The client sends the header and
   > the server replays from it, and both halves are tested — the hook is asserted to send the
   > id of the last delivered event on reconnect and no header at all on first connect, and the
   > express integration suite covers replay, in-flight emission, deduplication, listener leaks
   > and an unresolvable id. What does not exist is a single browser-driven test joining them:
   > the two halves are proven separately, against each other's contract, not in one round
   > trip. The reconnect-through-nginx e2e exercises a real disconnect but asserts on the
   > reconnect, not on replayed content. Closing this means extending that e2e to seed a
   > notification while the stream is down and assert it arrives on reconnect.

4. Logging out invalidates outstanding access tokens immediately, proven by a test that
   logs out and asserts the next request 401s.
5. Logging out **closes an open stream within one heartbeat interval**, proven by a test.
6. CORS: an allowed origin succeeds with credentials, a disallowed origin's preflight fails,
   and `OPTIONS` on the SSE location returns 204 promptly — all asserted through the nginx
   image, not the dev proxy.

   > **Met for the third clause, reworded for the other two.** `OPTIONS` on the SSE location
   > does return 204 promptly through the image, off a location carrying
   > `proxy_read_timeout 24h`, and `allowedHeaders` really does list `last-event-id` — that was
   > the clause worth proving and it is proven.
   >
   > "A disallowed origin's preflight **fails**" was the wrong word. Measured: `cors@2.8.6`
   > answers a disallowed origin by calling `next()` **without** handling the preflight at all,
   > so the request falls through to whatever the route mounts — a 401 from `requireAuth` on
   > `/notifications/stream`, a 200 with `Allow` on `/auth/login`. Nothing "fails"; the grant
   > header is simply withheld, which is what actually stops the browser. The e2e asserts the
   > absence of `Access-Control-Allow-Origin`, which is the check that matters.
   >
   > "An allowed origin succeeds **with credentials**" is not asserted through the image. The
   > e2e sends `Origin: http://localhost:5173` because only `WEB_URL` is in the allowlist — the
   > container's own origin is not — so the test proves the multi-frontend seam rather than
   > this SPA's own traffic, which is same-origin and sends no preflight at all.

7. Existing suites stay green in both repos.
