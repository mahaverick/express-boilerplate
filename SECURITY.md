# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability.
Email the maintainer listed in [CODEOWNERS](.github/CODEOWNERS) with a
description of the issue and, if possible, steps to reproduce it. Expect an
initial response within a few business days.

## Supported versions

This is a boilerplate, not a hosted service: only the `main` branch is
supported. Downstream projects generated from it are responsible for their
own patch cadence — `dependabot.yml` is wired up so that starts on day one.

## What this boilerplate implements

**Read this section before deciding what your project does not need to
build.** Registration, login, refresh-token rotation, session revocation and
an authenticated profile endpoint all ship today. Verify any claim below
with `grep` before trusting it — that is exactly how the table further down
came to be rewritten twice already. An earlier revision of this file
described bcrypt at cost 12, an explicit helmet CSP, and Bearer-token
authentication as shipped behaviour when **none of it existed**; a later
revision swung the other way and described **no** authentication, password
hashing or user table once all three had already shipped. Both directions
are dangerous for the same reason: this is the file a downstream project
reads to decide what it does _not_ have to build, so either a false "yes" or
a false "no" here silently removes a control from a real system.

### Authentication: JWT access tokens + opaque refresh tokens

`src/utilities/token.utilities.ts` implements two token types that are
deliberately opposite on every axis:

- **Access tokens** (`signAccessToken`/`verifyAccessToken`) are short-lived,
  signed JWTs (`jsonwebtoken`, HS256, pinned explicitly so a token cannot
  switch algorithm), carrying only the user's id (`sub`). They are stateless
  — verification never touches the database — and are sent as
  `Authorization: Bearer <token>`, checked by `requireAuth`
  (`src/middlewares/auth.middleware.ts`) on every protected route.
  `requireAuth` also reloads the user by id on every request rather than
  trusting the token's claims alone, specifically so disabling or
  soft-deleting an account invalidates every access token already issued to
  it, immediately, instead of waiting out `ACCESS_TOKEN_TTL`.
- **Refresh tokens** (`issueRefreshToken`/`rotateRefreshToken`) are opaque
  `crypto.randomBytes(32)` values — never JWTs. Only their SHA-256 hash is
  stored (`user_tokens.token_hash`); the raw value exists only in the
  httpOnly cookie handed to the client and is never written to the database
  or logged. **There is deliberately no `JWT_REFRESH_SECRET`** — a JWT
  refresh token would still need a server-side revocation store to be
  revocable at all (the entire point of a refresh token), so signing one
  buys nothing but leaks its claims to anyone holding it. An opaque, hashed
  token carries no information by itself; only this module and the
  `user_tokens` table it is checked against know what it means. A field
  that can never be read is not a placeholder reserved for later — it was
  removed from the environment schema outright.

### Refresh rotation and reuse detection

Every refresh grant rotates: `POST /api/v1/auth/refresh` reads the raw
token from its httpOnly cookie, exchanges it for a new one, and revokes the
old row. The exchange is one atomic SQL statement —
`UPDATE user_tokens SET revoked_at = now(), consumed_at = now() WHERE
token_hash = $1 AND purpose = $2 AND revoked_at IS NULL RETURNING *`
(`UserTokenRepository.claimOnce`, called here with `purpose = 'refresh'`) —
not a read-then-check-then-write sequence. That matters concretely: a
read-check-write would let two concurrent requests presenting the same
stolen token both observe `revoked_at IS NULL` and both succeed, silently
defeating reuse detection. The `purpose` predicate rides in that same
atomic statement, not a separate check: a token minted for one purpose
(email verification, password reset) can never be claimed as another,
including as a refresh token — the claim and the purpose check cannot be
split by a race, because they are the same UPDATE. The atomic claim means
Postgres itself decides
which single caller (if any) wins; a losing concurrent caller — including a
genuine reuse attempt racing the legitimate client — falls straight into
the reuse path below.

Presenting a token that is **already revoked** (because it was already
rotated, or already logged out) is treated as reuse: every token sharing
its `session_id` — the entire rotation chain from one login, on one device
— is revoked immediately (`revokeAllForSession`), not just the token
presented. A legitimate client only ever presents a refresh token once; a
second presentation of an already-used one means someone else has it, and
the whole chain is assumed compromised. An expired-but-not-yet-rotated
token is simply revoked, not treated as reuse — nothing else in that
session is implicated by an expiry.

### Session lifetime: a sliding window AND an absolute ceiling

Two clocks bound a session, and they answer different questions.

`REFRESH_TOKEN_TTL` (default 30d) is a **sliding** window: every rotation
issues a token with a fresh expiry, so this bounds how long a client may go
**idle**. On its own it bounds nothing else — with a 15-minute access
token, a normal client refreshes roughly four times an hour and never lets
one expire, so the session lives forever. So does an exfiltrated refresh
cookie: it stays valid until somebody happens to log out.

`SESSION_ABSOLUTE_TTL` (default 30d) is the **ceiling**: measured from the
login itself, never reset. `user_tokens.session_started_at` is written once
when a session begins and copied forward unchanged by every rotation
(`rotateRefreshToken`, `src/utilities/token.utilities.ts`), so it measures
the age of the **login**, not of the token presented. Past it, rotation
fails with 401 and the whole session family is revoked — the user signs in
again, and a stolen cookie has a definite end date whether or not anyone
noticed the theft.

The two default to the same 30 days so they agree out of the box, but they
are independent knobs: raising how long a client may be idle does not raise
how long one login may live. A deployment wanting the common "idle 30 days,
absolute 90" shape sets `REFRESH_TOKEN_TTL=30d` and
`SESSION_ABSOLUTE_TTL=90d`.

The ceiling is enforced on the rotation path only — the check runs when a
refresh token is presented, not by a background sweep. An access token
already issued stays valid for the remainder of its own (15-minute) life
after the ceiling passes. Note also that `user_tokens` accumulates a row per
rotation and nothing prunes it; see
[DATABASE.md](DATABASE.md#user_tokens-grows-without-bound-and-nothing-prunes-it).

### Password hashing: bcrypt at cost 12

Implemented: `src/utilities/password.utilities.ts` exports `hashPassword`/
`isPasswordValid`, backed by `BCRYPT_COST = 12` in
`src/constants/auth.constants.ts`.
`tests/unit/utilities/password.utilities.test.ts` asserts the cost embedded
in every hash it produces against that constant, and separately reads this
file off disk and asserts the number in the heading above still matches
`BCRYPT_COST` — so this sentence cannot drift from the code the way an
earlier revision of this file did (see the warning above this table).

[OWASP's current
guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
still prefers argon2id over bcrypt; a greenfield project with no existing
password column has no migration to plan and should take it instead. This
boilerplate already committed a `users` table with a bcrypt-shaped
`password_hash varchar(60)` column before this decision was revisited, so
bcrypt at cost 12 is the accepted, well-understood choice made here —
switching hashing algorithms afterwards requires either a dual-verify
migration path or a forced reset for everyone, which is the reason to decide
this deliberately rather than default into it.

Every password is also capped at 72 bytes (`MAX_PASSWORD_BYTES`, same file):
bcrypt itself silently ignores anything past that point, so without a cap
two different passwords sharing that 72-byte prefix would hash identically
and either would then verify successfully against the other's hash.
Hashing or verifying refuses an over-length password outright instead of
silently truncating it.

### Password policy: an 8-character floor, no composition rules

`registerSchema` (`src/validators/auth.validators.ts`) requires a password
of at least `MIN_PASSWORD_LENGTH` (8) characters and rejects nothing else —
no required uppercase, digit, or symbol. This follows [NIST SP
800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html)'s current guidance:
length matters more than complexity, and mandatory composition rules
measurably push real users toward _more_ predictable passwords (a
capitalised first letter, a `1` or `!` appended) rather than genuinely
harder-to-guess ones. This was an implementer's judgement call — the spec
this plan was built from does not dictate a password policy — recorded here
so a later maintainer does not "improve" it by bolting composition
requirements back on; that would be a regression against current guidance,
not a hardening.

Only registration enforces this floor. `loginSchema` deliberately applies
no length rule to the submitted password (only "is present"), so a login
attempt with a too-short or too-long password fails with the exact same
"invalid credentials" response as a wrong password for a real account — see
"User enumeration" below. Routing a bad-length login password through a
distinct validation error first would leak that distinction to an
unauthenticated caller before the controller ever gets a chance to make the
two paths agree.

### User enumeration: closed on `/login` and `/register`

**Scope this claim to the endpoint.** What follows is a property of
`POST /api/v1/auth/login` and `POST /api/v1/auth/register`. Both used to
leak whether an address was registered — login through response timing,
register through its status code — and both are closed now, register at
the cost of one accepted residual timing difference (below), not zero cost.

#### `/login`: identical responses, identical timing

`POST /api/v1/auth/login` (`src/controllers/auth.controller.ts`) answers an
unknown email and a wrong password for a real account with the same status
(401), the same body (`"Invalid email or password"`), and the same cost.
Returning the same body while skipping the bcrypt comparison for an unknown
email would still leak which addresses are registered — just through
response **timing** instead of response **content**, since a real password
check pays for a full bcrypt compare and a short-circuited "no such user"
would return almost immediately. `getDummyHash()` closes that gap: when no
user row matches, login still runs one real `isPasswordValid` comparison
against a fixed dummy hash, hashed at the same `BCRYPT_COST` every real
password uses, so both paths always pay the same cost. A deactivated
account (`active: false`) is rejected the same way, after the same
comparison, through the same error — "these credentials are correct but the
account is disabled" is not something this endpoint lets a caller learn.

**An unverified account is rejected the same way, and the message is
deliberately misleading.** `login`'s guard also rejects any account whose
`emailVerifiedAt` is still null, joined into the same combined condition
rather than a separate early return — so an unverified account gets the
identical `401` body and the identical bcrypt cost a wrong password would.
`'Invalid email or password'` is, in this case, literally false: the
credentials are correct, the account simply has not clicked its
verification link yet. That falsehood is accepted on purpose, for the same
reason the deactivated-account case accepts it — a truthful "this account
exists but isn't verified" would confirm both that the address is
registered and that the submitted password is right, to anyone merely
trying credentials against it. This trade is recorded here because it has a
real, ongoing cost: a legitimate user who registered and has not yet
checked their inbox sees the same generic error a mistyped password
produces, and files a support ticket that says "login is broken" rather
than "I haven't verified yet." That ticket is the accepted cost of not
handing an attacker a working oracle.

#### `/register`: closed by an identical response, not by a rate limit

`POST /api/v1/auth/register` now answers **every** request identically —
`202`, `'If that address can be registered, a verification email has been
sent.'`, `data: null` — whether the address is free, already taken, or
belongs to a soft-deleted row. `BaseRepository.create`'s unique-violation-
to-409 translation still fires on the duplicate; this endpoint catches that
specific failure and proceeds to the same response rather than letting it
become the answer. What differs between the two
branches is invisible to the caller: a free address gets a
verification-link email (`EMAIL_VERIFICATION_TEMPLATE_KEY`); a taken
address gets a "someone tried to register with your address" notice sent
to the account's **stored** name, never the submitted one. Nothing is
overwritten on the taken branch — see "Email verification" below for why
that specific choice matters.

**Residual timing, accepted.** Both branches already pay one full bcrypt
hash — `hashPassword` runs before the `create` call regardless of whether
the row is ultimately kept (`auth.controller.ts`) — so the two branches
differ only by one extra token `INSERT` on the free branch, an indexed
write on the order of a millisecond against a ~250ms bcrypt cost. That gap
is dominated by ordinary network jitter, not a signal an attacker can use,
and is recorded as accepted rather than engineered away.

What still constrains this endpoint is the registration limiter below: 100
attempts per hour from one IP. With the status-code oracle gone, that
limiter's job is no longer bounding enumeration — it is bounding the two
things register was already rate-limited for independently of the oracle:
bcrypt CPU exhaustion, and now, outbound mail volume, since every accepted
request sends an email down one branch or the other.

### Email verification: the password requirement, the token-burn trade, and an open gap

`POST /api/v1/auth/verify-email` takes `{ token, password }`, not the token
alone. That second field is load-bearing, not a UX nicety — see the
squatting scenario below for why omitting it would reopen a worse hole than
the one this feature closes.

**A wrong password burns the token.** `verifyEmail` claims the token row
(`claimToken`, which marks it consumed) **before** comparing the password —
so presenting a token is what spends it, correct password or not. A wrong
password on a genuine link fails exactly like an unknown token, and the
link is now dead: the same link with the correct password afterward still
fails. One link is one attempt. A legitimate typo costs the user a resend,
not a retry — accept that trade deliberately, since it generates its own
support tickets ("my verification link stopped working") that a retry-
tolerant design would not.

**Why the token alone is not enough — the squatting scenario.** An
attacker registers `victim@example.com` with a password of their own
choosing. The row now exists, unverified — and who registered first does
not matter to what follows, because the harmful step is always the same
one: `emailVerifiedAt` getting written at click time on a row whose
password the clicker did not set. If verification accepted the token
alone, both candidate policies for what happens next end in a silent
takeover, not a stalemate:

- _Overwrite the password on a taken-but-unverified address (newest
  registrant wins)_ — fails when the **victim** registered first and has
  not yet clicked. The attacker's later registration of the same address
  overwrites the victim's password, and a fresh verification link goes out
  to the victim's own inbox as if nothing had happened. The victim's own
  click then verifies the address with the attacker's chosen credentials.
- _Write nothing on the taken branch_ (what actually shipped) closes that
  specific hole and still fails through the only door left open: the
  address is "known and unverified," so `resend-verification` will mail
  the victim a fresh, live link for that row, and the victim's own click on
  it verifies the address the **attacker's** password is sitting on.

Both variants turn a denial of service into a silent account takeover using
the victim's own click as the final step. Requiring the password in the
verify call closes both at once: the attacker knows the password but can
never produce the mailed token; the mailbox owner can produce the token but
not the attacker's password. Neither half can complete verification alone,
so the worst outcome becomes a lockout — never a handover.

**That lockout is an open gap, named here rather than left as a footnote.**
Until password reset exists (B3 Task 6), a squatted address has **no**
recovery path: the real owner cannot verify it, because they do not know
the attacker's password, and the attacker cannot either, because they do
not control the mailbox. The row sits permanently unverified and
permanently unusable by the person who actually owns the address. This is
the accepted lesser failure — a denial of service the real owner can at
least notice and report, rather than a takeover they might never notice —
but it is a real, currently-unrecoverable state, not a theoretical one.
Task 6 closes it: a successful password reset must also set
`emailVerifiedAt`, since clicking a reset link is the same proof of mailbox
control verification already asks for.

**Backfilling `email_verified_at` before deploying the login gate.**
`login` now refuses any account whose `emailVerifiedAt` is null. Any
deployment upgrading from a version before this change has existing users
sitting at `email_verified_at IS NULL`, because until now nothing ever set
that column for anyone. Deploying the gate without a backfill first locks
out every existing user simultaneously, on the same release. Run this
**before** the deploy that adds the gate, not after and not alongside it:

```sql
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
```

This treats every pre-existing account as already verified, on the
reasoning that those users were already logging in successfully before this
feature existed at all — there is no attacker/victim ambiguity to resolve
for a row that predates the mechanism that creates that ambiguity. A fresh
deployment with no existing users has nothing to backfill.

### Rate limiting: one limiter per auth route, one store prefix each

`src/middlewares/rate-limit.middleware.ts` ships seven limiters — one for
every route on the auth router, `/verify-email` included, and
`/resend-verification` carrying two in series — which is a standing rule
for that router rather than seven separate decisions. Each is backed by its
**own** `SharedRateLimitStore`, with its own key prefix (`rl:register:`,
`rl:login:`, `rl:refresh:`, `rl:logout:`, `rl:verify-email:`,
`rl:resend-verification-ip:`, `rl:resend-verification-email:`), so no
endpoint can spend another's budget and a 429 is only ever a statement
about the endpoint that returned it. A new auth route — B3's
`/forgot-password` and `/reset-password` (Task 6) are next — takes its own
prefix on the same pattern; `tests/unit/middlewares/rate-limit.middleware.test.ts`
fails if two ever collide. `/verify-email` and `/resend-verification`'s
own per-limiter reasoning — including why `/resend-verification`'s IP layer
is the tight one and its email layer the generous one — lives in
`rate-limit.middleware.ts`'s own header comment. The store starts on an in-memory store and latches,
once, to a Redis-backed one the first time Redis is confirmed reachable —
never back — so the limit ends up shared across replicas rather than
per-process as soon as Redis is up. Until that first successful latch (or
whenever Redis stays unreachable), the store stays in-memory and the limit
is per-process only.

- **Register** (`POST /api/v1/auth/register`): 100 attempts per hour, keyed
  on the client's **IP alone** — deliberately not the composite login uses.
  Both threats here come from one caller varying the email, so any key
  containing the email would hand an attacker a fresh counter per request
  and bound nothing: enumeration (see above) changes the address by
  construction, and bcrypt CPU exhaustion does not care what the address is.
  That second threat is the reason this endpoint cannot stay unlimited at
  all — `register` hashes at cost 12 (~250ms) before anything else, and
  node-bcrypt runs on libuv's threadpool (4 threads by default, shared with
  fs and DNS), so a few dozen concurrent registrations starve the whole
  process, not just this route. Keying on IP means everyone behind one NAT'd
  egress address shares a counter, so the **limit**, not the key, is what
  keeps an office of real people from locking each other out: 100/hour sits
  far above any human signup rate and far below either attack. Two things
  make that trade acceptable here where it would not be for login — a 429 on
  registration delays a **new** signup and can never lock anyone out of an
  **existing** account, and it clears itself within the window with nobody
  intervening.
- **Login** (`POST /api/v1/auth/login`): 5 attempts per 15-minute window,
  keyed on the **composite** of the client's IP and the submitted email —
  deliberately neither alone. Email alone would let anyone who merely knows
  a victim's address lock that victim out of their own account: submit
  wrong passwords against someone else's email from anywhere, and the real
  owner starts seeing 429s too — a free denial-of-service needing no
  credentials of the attacker's own. IP alone is bypassed by a distributed
  attacker (many source IPs, one target account), since every IP would
  carry its own independent counter. The key is built from the raw request
  body before validation, and never checks whether the submitted email
  belongs to a real account, so the number of attempts before a 429 cannot
  be used to probe which addresses are registered — that would reopen the
  exact enumeration channel closed above.
- **Refresh** (`POST /api/v1/auth/refresh`): 300 requests per 5-minute
  window, keyed on IP alone. This is explicitly **volume/abuse protection,
  not a security control**: a raw refresh token is 256 bits of randomness,
  so guessing one is infeasible regardless of any rate limit, and replaying
  an already-rotated token gains an attacker nothing beyond the first
  attempt — reuse detection (above) revokes the whole session on that first
  replay, so a burst of further attempts fails identically to the first.
  What this limiter actually bounds is the request/database load one client
  can generate against an endpoint that does two writes per call; its limit
  is generous precisely because tightening it would only cost real users
  retrying a flaky connection, for a property reuse detection already
  provides.
- **Logout** (`POST /api/v1/auth/logout`): 300 requests per 5-minute window,
  keyed on IP alone — volume protection on the same reasoning as refresh.
  Logout is unauthenticated by design (a user whose access token has just
  expired must still be able to end their session), so an anonymous caller
  can drive one indexed lookup by token hash plus at most one bounded
  `UPDATE` per request; that load is what this bounds. It closes no oracle,
  because there is none — every logout answers 200 whether the presented
  token was live, already revoked, forged, or absent. Its limit is generous
  for a reason specific to this route: a 429 answers **before** the handler
  runs, so it would leave the refresh cookie uncleared. This limiter must
  never plausibly be the reason a real user cannot log out.

There is no general-purpose rate limiter beyond the auth router's four
routes.

### Deploying behind a proxy: `TRUST_PROXY` is a required decision

**If you deploy this behind an ingress, a load balancer, a CDN, or any
reverse proxy, you must set `TRUST_PROXY`. Leaving it unset is a real
misconfiguration, not a safe default.**

Every limiter above keys on `request.ip`. Express derives that from the
socket's peer address unless `trust proxy` is set — so behind a proxy, the
peer is the **proxy**, and `request.ip` is the same value for every request
that ever arrives. All four limiters then collapse into one bucket for the
entire deployment: refresh's "300 per 5 minutes" becomes 300 requests per 5
minutes shared by all users, and a single noisy client denies refresh to
everyone else.

The opposite error is worse, and is why this is configuration rather than
something turned on by default. `X-Forwarded-For` is an ordinary request
header; anything that can reach the app can write whatever it likes into it.
Trust it too eagerly and a caller picks its own "client IP" on every
request, gets a fresh rate-limit bucket each time, and the login limiter
stops applying at all. **`TRUST_PROXY=true` is refused at boot** for exactly
this reason (`src/configs/env.config.ts`) — it is the value that gets typed
by accident, and every legitimate use of it can be written as a hop count or
an address list instead.

What to set:

| Deployment                                   | Value                                       |
| -------------------------------------------- | ------------------------------------------- |
| Clients reach the app directly               | `false` (the default)                       |
| Exactly one proxy in front (typical ingress) | `1`                                         |
| A known chain (e.g. CDN → load balancer)     | `2` — the number of hops you control        |
| Proxies on a known network                   | `10.0.0.0/8` (comma-separated list is fine) |
| Docker/compose networking only               | `uniquelocal`                               |

Count only the proxies **you** control. Each extra hop of trust is one more
position from which `X-Forwarded-For` can be forged. `createApp()` applies
the value at boot and a malformed one throws there, so a typo stops the
process rather than quietly disabling the limiters.

### Cookies: httpOnly, environment-derived `secure`, `sameSite: 'strict'`

The refresh token travels only in a cookie (`REFRESH_TOKEN_COOKIE_NAME`,
scoped to `REFRESH_TOKEN_COOKIE_PATH` = `/api/v1/auth` so no other route
ever receives it), set with:

- `httpOnly: true` — no script on the frontend origin can ever read the raw
  value.
- `secure: isSecureCookieEnvironment()` — exactly `NODE_ENV === 'production'`,
  not a hardcoded literal in either direction. A hardcoded `true` would make
  cookie-based login impossible over plain HTTP in local development
  (browsers refuse a `Secure` cookie set over `http://`); a hardcoded
  `false` would ship a refresh token over an unencrypted connection in
  production.
- `sameSite: 'strict'` — the cookie half of this API's CSRF position (see
  below).

**`sameSite: 'strict'` assumes the frontend and this API share a
registrable domain (eTLD+1).** Flagged here for revisiting when OAuth lands
in a later plan (B4): a cross-site redirect back from an identity provider
is exactly the navigation `'strict'` suppresses — the cookie would not be
sent on the browser's return trip from the IdP, breaking the flow. A
deployment that splits the frontend and API across different top-level
domains, or that adds a third-party OAuth redirect, needs `'lax'` (for the
top-level-navigation case OAuth needs) or a real CSRF token instead.

### Mass assignment: an explicit allow-list on profile updates

`PATCH /api/v1/profile` (`src/validators/profile.validators.ts`,
`src/controllers/profile.controller.ts`) writes only the fields
`updateProfileSchema` names — `firstName` and `lastName` — no matter what
else a request body contains. `email`, `id`, `passwordHash` and `active`
cannot be set through this endpoint: the schema is a plain (non-`.strict()`)
allow-list that silently strips every unrecognised key rather than
rejecting the whole request, and `toUpdateValues` in the controller only
ever reads the two keys that schema can produce — there is deliberately no
second, independent allow-list re-checking this, since a second definition
is exactly what would drift from the first over time. Verified directly
against this repo: `PATCH` with `{"firstName":"Alicia","active":false,
"email":"attacker@example.com","passwordHash":"x","id":"deadbeef"}` against
a real session updated only `firstName`; every other field was silently
dropped.

## What this boilerplate does NOT implement

Everything below genuinely ships nothing today, in either direction:

| Control                       | Status              | What that means for you                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF tokens                   | **Not implemented** | See "No CSRF middleware" below — reasoning, not an oversight. The forced-login direction IS defended, by a content-type gate on the auth router; see the section after it.                                                                                                              |
| MFA                           | **Not implemented** | No TOTP enrolment, no recovery codes. Owned by a later plan (B4).                                                                                                                                                                                                                       |
| Forgot / reset password       | **Not implemented** | No `/forgot-password` or `/reset-password` route exists — email _verification_ is implemented (see "Email verification" above); this is the recovery half. It is also the only recovery path for a squatted address. Owned by plan B3 Task 6 — see ARCHITECTURE.md's "B3 seam" section. |
| OAuth / social login          | **Not implemented** | No provider integration. Owned by a later plan (B4).                                                                                                                                                                                                                                    |
| Tenancy / RBAC                | **Not implemented** | Every authenticated user has the same access to their own resources; there is no role or organization model.                                                                                                                                                                            |
| General-purpose rate limiting | **Partial**         | All six auth routes are covered (above, seven limiters total — `resend-verification` carries two). No limiter exists on the profile routes or any future non-auth route.                                                                                                                |

`JWT_ACCESS_SECRET` is required by the environment schema and **is** read —
by `signAccessToken`/`verifyAccessToken`. `WEB_URL` is also read now, twice
over: `verification-link.utilities.ts` builds the mailed link from it, and
`origin.utilities.ts` (see "CORS" below) decides from it whether a
browser's `Origin` gets a grant. `APP_URL` and `SESSION_SECRET` remain
required by the schema and read by nothing — they are forward declarations
for the email/session plans, not evidence those exist. There is no
`JWT_REFRESH_SECRET` at all (see "Authentication" above).

## CORS

`cors` middleware is mounted (`src/configs/cors.config.ts`, `src/app.ts`),
answering with `credentials: true` and an origin callback
(`isAllowedOrigin`, `src/utilities/origin.utilities.ts`) that grants exactly
`WEB_URL` plus any origin listed in `CORS_ALLOWED_ORIGINS` — never a
wildcard, which the CORS spec forbids alongside `credentials: true` anyway.
A request with no `Origin` header (same-origin, or any non-browser client)
is always allowed; CORS is a browser-only mechanism and there is nothing to
enforce against a client that doesn't send one.

**Accepted consequence, not a vulnerability.** The content-type CSRF gate
below still holds exactly as designed — a disallowed origin still gets no
grant header, and an HTML form still cannot send `application/json` — but
its blast radius changed the moment an origin allowlist existed to grant
against. Before this seam, no origin (other than same-origin) could ever
pass a preflight, so the content-type gate was the only thing standing
between a script and this API regardless of where it ran. Now, any origin
listed in `CORS_ALLOWED_ORIGINS` (a second frontend on a sibling
subdomain, by design) CAN drive a credentialed, `application/json`
cross-origin request. That means an XSS or full takeover of that second
frontend now reaches this API the same way the primary frontend does —
somewhere it could not reach before. This is the deliberate trade this
feature makes to let a second frontend call the API at all, not an
oversight to fix; it is the reason `CORS_ALLOWED_ORIGINS` should list only
origins this deployment actually trusts with the primary frontend's own
level of access.

## Security headers

`helmet` (`src/configs/helmet.config.ts`) is the first middleware mounted in
`src/app.ts` — before `cors`, before the body parsers, before any route —
so every response carries these headers, including a 404, a 415 rejection,
an error response, and a CORS preflight:

- `Content-Security-Policy: default-src 'none';frame-ancestors 'none'` —
  this API serves no HTML, so the policy forbids loading any resource type
  and blocks framing entirely, rather than allow-listing script/style
  sources that don't apply to a JSON API.
- `Cross-Origin-Resource-Policy: same-site`, not helmet's default
  `same-origin`. CORP is a separate check from CORS: it is only consulted
  for a `no-cors` request (an `<img>`/`<script>`-style embed, or anything
  under `Cross-Origin-Embedder-Policy`), never for the credentialed
  `fetch`/XHR calls the frontends actually make — those are gated by CORS
  alone, and `same-origin` would not have broken them. The reason to set it
  anyway is the no-cors case itself: the second frontend on a sibling
  subdomain (`CORS_ALLOWED_ORIGINS`, see "CORS" above) is a different
  origin but the same registrable site, so `same-origin` would refuse even
  a harmless no-cors embed from it. `same-site` allows that while still
  refusing one from any origin outside the registrable domain.
- `Referrer-Policy: no-referrer` — no `Referer` header leaks to anywhere,
  including this API's own other origins.
- `X-Content-Type-Options: nosniff` — stops a browser from MIME-sniffing a
  JSON response body into something it will execute.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` —
  helmet's default; a browser only honours this over HTTPS, so it is inert
  in local HTTP development.

`app.disable('x-powered-by')` (`src/app.ts`) stays in place alongside
helmet's own `X-Powered-By` removal — harmless, and explicit about intent.

## No CSRF middleware — reasoning about the shipped design

This reasoning was originally written about an intended, unbuilt design; it
now describes the shape that actually shipped, and the conclusion still
holds. CSRF relies on a browser automatically attaching ambient credentials
(a session cookie) to a cross-site request. This API's credentials are not
purely ambient: an `Authorization: Bearer <token>` header is never attached
automatically by a browser, so the access token can't be used cross-site
without the frontend's own code choosing to send it. The one credential
that _is_ a cookie — the refresh token — is `sameSite: 'strict'`, which
blocks the browser from attaching it to a cross-site request in the first
place (see "Cookies" above, including the eTLD+1 assumption and the OAuth
flag). If a project changes `sameSite` away from `'strict'` (the OAuth case
above is the concrete reason this might happen), or layers a browser
session on top of this boilerplate (the `SESSION_SECRET` path), this
conclusion no longer holds and CSRF protection must be revisited explicitly.

### The other CSRF direction: forced login

Everything above reasons about an attacker making a victim's browser act
**with the victim's credentials**. There is a second direction, and this
file did not consider it until it was found in review: an attacker making a
victim's browser log in **with the attacker's credentials**.

`app.ts` mounts `express.urlencoded()` globally, so `POST
/api/v1/auth/login` used to accept a form-encoded body. An attacker's page
could auto-submit a cross-site form to it carrying the attacker's own email
and password. A cross-site form POST needs no CORS permission — the browser
sends it and merely hides the response — and `sameSite: 'strict'` is no
defence here, because **it governs when a cookie is sent, not whether a
cross-site response may set one**. The victim's browser stores the reply's
`Set-Cookie` and the victim is now silently signed into the attacker's
account. Everything they do next — a document uploaded, a card saved, a
search typed — happens inside an account the attacker can log into and read
at leisure.

Closed by `requireJsonContentType`
(`src/middlewares/content-type.middleware.ts`), mounted on the whole auth
router so B3's routes inherit it: a request declaring any content type other
than `application/json` is refused with **415**, before the handler sees the
body. An HTML form can only ever submit
`application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
so refusing those three removes the form vector by construction; and
requiring `application/json` forces a CORS preflight on any cross-origin
script. This API now DOES answer that preflight (see "CORS" above) — an
allowed origin gets a grant and proceeds to this gate on its own merits, a
disallowed one still gets no grant header and is blocked by the browser
before this middleware ever runs. Either way, the HTML-form vector this gate
exists for sends no preflight at all and is refused here regardless of CORS.

A content-type gate was chosen over relying on the Origin allow-list alone
because it needs no configuration of its own and holds even for a
same-origin deployment with `CORS_ALLOWED_ORIGINS` unset — the allowlist can
be misconfigured or absent; this gate cannot be. A request declaring **no**
content type is allowed, because an untyped body is inert: neither body
parser parses one, so it never reaches a validator, and `/refresh` and
`/logout` are legitimately called with no body at all.

## Design decisions that ARE implemented

Each is written down because "we have no protection here" and "this attack
does not apply to this design" look identical in a code review, and only one
of them is a finding.

### Error logs never carry bound query parameters

A 5xx is logged server-side (`src/middlewares/error.middleware.ts`) so a
masked "Internal server error" is still diagnosable. What gets logged is
redacted first: a failed database query is recorded as its **SQL text**
(parameterised, so it names tables and columns and holds no values), the
driver's `SQLSTATE` code, and the call frames — never its bound parameters.

This is not a theoretical precaution. `drizzle-orm` builds
`DrizzleQueryError`'s message as `` `Failed query: ${query}\nparams:
${params}` `` (`node_modules/drizzle-orm/errors.js`), so logging the error
object put the parameters of the failing statement into the log. For a
failed `insert into users` those parameters are the registrant's **email
address and bcrypt hash**. `BaseRepository` intercepts only `23505` (unique
violation, answered 409); every other failure — an over-long value, a check
violation, a dropped connection mid-statement — propagated intact. The
driver error's own message and `detail` are dropped for the same reason at
one remove: Postgres embeds offending values in some of them (`Key
(lower(email))=(...) already exists.`).

Separately, and for the same underlying bug: every string field a request
body can set is now capped at exactly the width of the column it is written
to (`MAX_EMAIL_LENGTH`/`MAX_NAME_LENGTH`, `src/constants/auth.constants.ts`
— the same constants `user.model.ts` declares those columns with). A schema
looser than its column does not just fail; it fails as a **500**, because
Postgres's `22001` is not a unique violation and nothing translates it. A
400-character email address did exactly that.

### Secret scanning at two layers

[`gitleaks`](https://github.com/gitleaks/gitleaks) runs as an optional local
pre-commit hook (`.pre-commit-config.yaml`, `.gitleaks.toml`) and as a
blocking check on every pull request
(`.github/workflows/gitleaks.yml`). The local hook alone is not a gate — it
is one `git commit --no-verify` away from being skipped — so the CI workflow
is the actual enforcement layer; the pre-commit hook exists to catch a leak
before it is even pushed.

### Domain-leak gate

This boilerplate is derived from a production codebase by stripping
project-specific terms. `.github/workflows/ci.yml`'s "Reject domain leakage"
step greps the tree for the terms that must never reappear, so a missed scrub
fails CI instead of shipping silently.

### No `npx <tool>@latest` in committed agent config

An earlier draft of this repository's documentation shipped a `.mcp.json`
declaring an MCP server as `npx shadcn@latest mcp`, plus a
`.claude/settings.json` that auto-enabled a plugin. Both were rejected
before merging, for reasons worth keeping visible so the same shape doesn't
reappear:

- **Unpinned execution outside the lockfile.** `npx <pkg>@latest` resolves
  and runs whatever is newest on the npm registry at the moment the tool
  launches — not a version anyone reviewed, not a version pnpm's lockfile
  or `pnpm audit` has any visibility into. A compromise of that package or
  its publishing account is code execution on every machine that opens the
  repo, with no review window between publish and execution.
- **Auto-enabling removes the one consent step that would catch it.** A
  `.claude/settings.json` that enables a plugin or server by default means
  a contributor never sees, let alone approves, what just started running.
- **A boilerplate multiplies the exposure.** This isn't one repository's
  risk; it's every project generated from this template inheriting the
  same unpinned, auto-enabled server on day one.
- It was also, independently, a frontend tool (a React component
  generator) copied into a backend API's agent config without checking
  whether anything here would ever use it. Nothing does.

**The rule:** a project that wants an MCP server adds one deliberately, at
a version pinned in the committed config (not `@latest`), and does not
auto-enable it for every contributor by default.
