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
`UPDATE user_tokens SET revoked_at = now() WHERE token_hash = $1 AND
revoked_at IS NULL RETURNING *` (`UserTokenRepository.claimForRotation`) —
not a read-then-check-then-write sequence. That matters concretely: a
read-check-write would let two concurrent requests presenting the same
stolen token both observe `revoked_at IS NULL` and both succeed, silently
defeating reuse detection. The atomic claim means Postgres itself decides
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

### User enumeration: identical responses, identical timing

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

### Rate limiting: login (IP + email) and refresh (IP, volume only)

`src/middlewares/rate-limit.middleware.ts` ships two limiters, each backed
by `SharedRateLimitStore`: it starts on an in-memory store and latches,
once, to a Redis-backed one the first time Redis is confirmed reachable —
never back — so the limit ends up shared across replicas rather than
per-process as soon as Redis is up. Until that first successful latch (or
whenever Redis stays unreachable), the store stays in-memory and the limit
is per-process only.

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

There is no general-purpose rate limiter beyond these two routes.

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

| Control                         | Status              | What that means for you                                                                                                                                   |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF tokens                     | **Not implemented** | See "No CSRF middleware" below — reasoning, not an oversight, and still holds for the shipped cookie/token shape.                                         |
| Security headers / CSP          | **Not implemented** | `helmet` is not a dependency. Only `x-powered-by` is disabled (`src/app.ts`).                                                                             |
| CORS                            | **Not implemented** | No `cors` middleware; `WEB_URL` is validated but nothing reads it.                                                                                        |
| MFA                             | **Not implemented** | No TOTP enrolment, no recovery codes. Owned by a later plan (B4).                                                                                         |
| Email delivery and verification | **Not implemented** | `users.email_verified_at` exists as a column; nothing issues, sends, or verifies a token yet. Owned by plan B3 — see ARCHITECTURE.md's "B3 seam" section. |
| OAuth / social login            | **Not implemented** | No provider integration. Owned by a later plan (B4).                                                                                                      |
| Tenancy / RBAC                  | **Not implemented** | Every authenticated user has the same access to their own resources; there is no role or organization model.                                              |
| General-purpose rate limiting   | **Partial**         | Login and refresh are covered (above). No limiter exists on registration, profile, or any future route.                                                   |

`JWT_ACCESS_SECRET` is required by the environment schema and **is** read —
by `signAccessToken`/`verifyAccessToken`. `APP_URL`, `WEB_URL` and
`SESSION_SECRET` remain required by the schema and read by nothing — they
are forward declarations for CORS/email/session plans, not evidence those
exist. There is no `JWT_REFRESH_SECRET` at all (see "Authentication"
above).

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

## Design decisions that ARE implemented

Each is written down because "we have no protection here" and "this attack
does not apply to this design" look identical in a code review, and only one
of them is a finding.

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
