# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability.
Email the maintainer listed in [CODEOWNERS](.github/CODEOWNERS) with a
description of the issue and, if possible, steps to reproduce it. Expect an
initial response within a few business days.

## Supported versions

1.x is supported. This is a boilerplate, not a hosted service: a project
generated from it owns its own patch cadence, and `renovate.json` is wired up
so that starts on day one.

## What this boilerplate implements

**Read this section before deciding what your project does not need to
build.** Registration, login, refresh-token rotation, session revocation,
email verification, password reset and change, Google sign-in, tenancy with
role-based access, and platform staff access all ship. Verify any claim below
with `grep` before trusting it. This is the file a downstream project reads to
decide what it does _not_ have to build, so a false "yes" and a false "no" are
equally dangerous: either one silently removes a control from a real system.

### Authentication: JWT access tokens + opaque refresh tokens

`src/services/session.service.ts` implements two token types that are
deliberately opposite on every axis:

- **Access tokens** (`signAccessToken`/`verifyAccessToken`) are short-lived,
  signed JWTs (`jsonwebtoken`, HS256, pinned explicitly so a token cannot
  switch algorithm), carrying the user's id (`sub`) plus the session id
  (`sid`) and the token's own id (`jti`, unchecked — it exists so a token
  accepted after a Redis flush can be identified in logs). They are
  stateless — verification never touches the database — and are sent as
  `Authorization: Bearer <token>`, checked by `requireAuth`
  (`src/middlewares/auth.middleware.ts`) on every protected route.
  `requireAuth` also reloads the user by id on every request rather than
  trusting the token's claims alone, so disabling or soft-deleting an account
  invalidates every access token already issued to it, immediately, instead
  of waiting out `ACCESS_TOKEN_TTL`.
- **Refresh tokens** (`issueRefreshToken`/`rotateRefreshToken`) are opaque
  `crypto.randomBytes(32)` values — never JWTs. Only their SHA-256 hash is
  stored (`user_tokens.token_hash`); the raw value exists only in the
  httpOnly cookie handed to the client and is never written to the database
  or logged. **There is deliberately no `JWT_REFRESH_SECRET`.** A JWT refresh
  token would still need a server-side revocation store to be revocable at
  all, so signing one buys nothing but leaks its claims to anyone holding it.
  An opaque, hashed token carries no information by itself; only this module
  and the `user_tokens` table it is checked against know what it means.

### Refresh rotation and reuse detection

Every refresh grant rotates: `POST /api/v1/auth/refresh` reads the raw token
from its httpOnly cookie, exchanges it for a new one, and revokes the old
row. The exchange starts with one atomic SQL statement,
`UserTokenRepository.claimOnce`: an `UPDATE user_tokens SET revoked_at = now(),
consumed_at = now()` whose `WHERE` matches the token hash, `purpose =
'refresh'`, `revoked_at IS NULL` and a row that is not soft-deleted, with
`RETURNING *`. It is not a read-then-check-then-write sequence, which would let
two concurrent requests presenting the same stolen token both observe
`revoked_at IS NULL` and both succeed. The `purpose` predicate rides in that
same statement, so a token minted for one purpose (email verification,
password reset) can never be claimed as another, including as a refresh
token. Postgres itself decides which single caller (if any) wins; a losing
concurrent caller falls into the reuse path below.

Presenting a token that is **already revoked** (because it was already rotated,
or already logged out) is reuse. Within `REFRESH_REUSE_GRACE_MS` (10s) of that
rotation, and only if the session hasn't since been explicitly killed (logout,
an earlier reuse, a password reset), reuse mints a sibling refresh token in the
same session instead of revoking it — the accepted trade-off that lets two
legitimate concurrent requests (two tabs refreshing at once) both succeed. Past
that window, or once the session is killed, reuse revokes every token sharing
its `session_id` — the entire rotation chain from one login, on one device — not
just the token presented; a legitimate client only ever presents a refresh token
once, so a second presentation outside the grace window means someone else has
it. An expired-but-not-yet-rotated token is simply revoked, not treated as
reuse — nothing else in that session is implicated by an expiry. A sibling minted
inside the grace window is a **permanent second chain**. It shares the session,
and rotates on its own until `SESSION_ABSOLUTE_TTL`, until it goes unused for
`REFRESH_TOKEN_TTL`, or until that session ends: a logout from either chain, a
password reset, a password change or `POST /auth/sessions/revoke-others` made
from another session, a Google account claim, a staff sign-out, deactivation or
deletion, or a sign-in in a browser that presents either chain's cookie. A
password change or `revoke-others` made from that session ends it too when the
browser presents its refresh cookie, which it does on both routes (they sit
under the cookie's path). The cookie spares only its own row, and only when it
is the caller's live refresh token: same user, the access token's session, not
revoked. Every other row of the user goes, the sibling included. A client that
presents no such cookie (a non-browser client, or a cookie that is unknown,
revoked or another session's) spares the caller's whole session, sibling and
all, as before. The sibling's access tokens carry the caller's session id, so
they are not denied (that would deny the caller too) and stay valid until they
expire (`ACCESS_TOKEN_TTL`). The sibling's next refresh is then reuse, which
ends the whole session, the caller's chain included. Ending the sibling does not
cost the caller's chain its grace window: only a kill recorded at or after the
replayed token's rotation refuses grace (`isSessionKilled`), and the sibling's
revoke is older than any later rotation of the caller's chain. A kill's
`revoked_at` is stamped at the moment of the write (`clock_timestamp()`, never
the transaction's `now()`), so it is never earlier than a claim that committed
before it: a kill that began before a racing rotation's claim still reads as
later than it and still refuses grace. The one exception is a replay, within its 10 s window, of a
token rotated just before that revoke: it is refused as reuse. The caller can
also be the thief: whoever holds the sibling and its access token is a caller of
the same session, and a `revoke-others` with the sibling's cookie spares the
thief's chain and ends the victim's, until the victim's next refresh is reuse
and ends both. That adds nothing: a logout with the sibling's cookie already
ends the session, and `revoke-others` already ended every other session. Under
`COOKIE_SECURE` with `COOKIE_DOMAIN` set the cookie is `__Secure-`, which a host
under that domain can plant; a planted cookie still has to be a live refresh
token of the same user and session (in practice the thief's own sibling), and
then the request spares the thief's chain and ends the victim's in the same
way. Under `COOKIE_SECURE` without `COOKIE_DOMAIN` the cookie is `__Host-` and
cannot be planted. Without `COOKIE_SECURE` it is the unprefixed `refreshToken`,
which a sibling host or an on-path attacker over plain http can plant.
Otherwise reuse detection never catches a sibling, unless a token
one of the two chains already consumed is replayed after the window. The window
is 10 s, so a thief must replay within 10 s of the real client's rotation to
get one.

A refresh answered 401 clears the cookie it read, in the same forms the
logout clear uses for that name, so the browser stops presenting a dead token
on every page load. No 401 leaves that token able to refresh: it is unknown
or of another purpose, its session was killed, it expired, it is a refresh
row without a session, or the account is gone or inactive. A replay inside
the grace window gets a sibling instead, so a 401 that races a successful
rotation cannot wipe a cookie that still works. The one exception is a login
or Google sign-in in another tab that lands while a dead-cookie refresh is in
flight: the 401 clears by name, so the new cookie goes too, and the user
signs in again. The limiter's 429 and a 5xx clear nothing.

Signing in again in the same browser ends the session of any refresh cookie that
browser still presents, current or legacy name (`revokePresentedSessions`, run
after `login` and the Google callback issue the new session, as logout does).
Without it the overwritten cookie's session stays refreshable for up to
`REFRESH_TOKEN_TTL`, outlives the user's next logout, and can never trip reuse
detection, so a thief holding it would rotate it alone. A Google sign-in sees
only the cookie its cross-site return carries, a `Lax` one from an earlier
Google sign-in. A `Strict` cookie from a password login is withheld, so that
session is not ended, and the new cookie then replaces it in the browser, so the
user can no longer log out of it there: it stays refreshable until it lapses
(`REFRESH_TOKEN_TTL` unused, or `SESSION_ABSOLUTE_TTL`) or something ends the
user's other sessions (a password change or `revoke-others` from the new
session, a password reset, or a staff sign-out).

### Session lifetime: a sliding window AND an absolute ceiling

Two clocks bound a session, and they answer different questions.

`REFRESH_TOKEN_TTL` (default 30d) is a **sliding** window: every rotation
issues a token with a fresh expiry, so this bounds how long a client may go
**idle**. On its own it bounds nothing else — with a 15-minute access token,
a normal client refreshes roughly four times an hour and never lets one
expire, so the session lives forever. So does an exfiltrated refresh cookie.

`SESSION_ABSOLUTE_TTL` (default 30d) is the **ceiling**: measured from the
login itself, never reset. `user_tokens.session_started_at` is written once
when a session begins and copied forward unchanged by every rotation
(`rotateRefreshToken`), so it measures the age of the **login**, not of the
token presented. Past it, rotation fails with 401 and the whole session is
revoked — the user signs in again, and a stolen cookie has a definite end
date whether or not anyone noticed the theft.

The two default to the same 30 days, but they are independent knobs: raising
how long a client may be idle does not raise how long one login may live. A
deployment wanting "idle 30 days, absolute 90" sets `REFRESH_TOKEN_TTL=30d`
and `SESSION_ABSOLUTE_TTL=90d`.

The ceiling is enforced on the rotation path only — the check runs when a
refresh token is presented, not by a background sweep. An access token
already issued stays valid for the rest of its own (15-minute) life after the
ceiling passes. `user_tokens` accumulates a row per rotation; the daily
retention purge deletes a rotated-away row only once it has expired, so reuse
detection keeps every row a client could still present. See
[DATABASE.md](DATABASE.md#user_tokens-retention).

### Password hashing: bcrypt at cost 12

`src/utilities/password.utilities.ts` exports `hashPassword`/
`isPasswordValid`, backed by `BCRYPT_COST = 12` in
`src/constants/auth.constants.ts`.
`tests/unit/utilities/password.utilities.test.ts` asserts the cost embedded in
every hash it produces against that constant, and reads this file off disk to
assert the number in the heading above still matches `BCRYPT_COST`.

[OWASP's current
guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
prefers argon2id over bcrypt. `users.password_hash` is `varchar(60)`, bcrypt's
output length, and switching algorithms once real passwords are stored needs
either a dual-verify migration path or a forced reset for everyone. A project
that wants argon2id should switch before it has users.

Every password is capped at 72 bytes (`MAX_PASSWORD_BYTES`, same file): bcrypt
silently ignores anything past that point, so without a cap two different
passwords sharing a 72-byte prefix would hash identically and either would
verify against the other's hash. Hashing or verifying refuses an over-length
password outright instead of silently truncating it.

Raising `BCRYPT_COST` opens a timing difference on `/login` until every stored
hash is rewritten at the new cost; `BCRYPT_COST`'s own comment explains why,
and the remedy (rehash on login) is not built.

### Password policy: an 8-character floor, no composition rules

Every password a user sets — `registerSchema`, `resetPasswordSchema` and
`changePasswordSchema`'s `newPassword` (`src/validators/auth.validators.ts`) —
must be at least `MIN_PASSWORD_LENGTH` (8) characters and at most
`MAX_PASSWORD_BYTES` bytes, and nothing else — no required uppercase, digit,
or symbol. This follows [NIST SP
800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html): length matters more
than complexity, and mandatory composition rules push real users toward
_more_ predictable passwords (a capitalised first letter, a `1` or `!`
appended). Bolting composition requirements back on is a regression against
that guidance, not a hardening.

`loginSchema` deliberately applies no length rule to the submitted password
(only "is present"), so a login attempt with a too-short or too-long password
fails with the same "invalid credentials" response as a wrong password for a
real account — see "User enumeration" below. A distinct validation error for
a bad-length login password would leak that distinction to an
unauthenticated caller.

### Password change and reset against a concurrent login

A login that checked the old password can't keep a session once a password
change or reset commits. Both writes run in one transaction that locks the
user row `FOR NO KEY UPDATE`, writes the new hash, and revokes the user's
`user_tokens` rows: every session for a reset, every session but the caller's
for a change (every session, the caller's included, when the caller's access
token carries no session id). A reset also revokes every token once before
that transaction, without the lock, so a failed write still leaves no session
alive. Login still checks the password outside any transaction. It then opens
a short one that locks the same row `FOR SHARE` and re-reads the hash. If the
hash changed, it answers the same `401 Invalid email or password`; otherwise
it issues the refresh token inside that transaction. So either the login
commits first and the password write revokes its session, or the login sees
the new hash and fails. There is no third ordering.

Refresh rotation also locks the user row `FOR SHARE`, so a refresh racing a
password write either has its new token revoked or gets 401.

`POST /auth/sessions/revoke-others` revokes every refresh token of the caller
except the calling session's, plus reset and verification links, under the user
row lock, then denies the revoked sessions' access tokens at once (best-effort,
as every revocation). When the request presents the caller's live refresh
cookie, only that one token is spared, so a grace-window sibling in the calling
session ends too; it is not counted in the reply's `revoked`, which counts other
sessions. A password change spares the same way. A token without a session id
is refused 401. 10 an hour per user.

Every path that locks the user row:

| Path                                                                                            | User row lock       | Why                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password change, password reset, sign out other sessions                                        | `FOR NO KEY UPDATE` | Writes the hash (a password change or reset) and revokes sessions atomically                                                                                                                                               |
| Google account claim, logout, reuse kill, lifetime kill                                         | `FOR NO KEY UPDATE` | Revokes sessions so no rotation in flight survives                                                                                                                                                                         |
| Step-up (`markSessionReauthenticated`, `POST /auth/reauthenticate`)                             | `FOR NO KEY UPDATE` | Re-checks the account is active and moves the session's `authenticated_at`                                                                                                                                                 |
| Login (after the password compare), Google sign-in (after the account lookup), refresh rotation | `FOR SHARE`         | Issues a token only against the hash, account state and session state it checked: login and Google sign-in re-check `active` under the lock, so a deactivation or deletion that committed since the first read answers 401 |
| A staff write's actor (`assertStillPlatformRole`)                                               | `FOR SHARE`         | A deactivation of the acting staff member waits for the write or is seen by it                                                                                                                                             |
| A staff user action's target (`lockStaffPair`)                                                  | `FOR NO KEY UPDATE` | Deactivate, reactivate, sign-out, edit and delete act on the row they read                                                                                                                                                 |

Logins and rotations take `FOR SHARE`, and their `FOR SHARE` locks never
conflict with each other. A concurrent login's `last_logged_in_at` update does
wait for the `FOR SHARE` transactions open on the row; each holds it for one
token insert (a login) or one rotation (a refresh). The reuse and lifetime
kills run after the rotation's transaction commits, in a transaction of their
own; taking `FOR NO KEY UPDATE` inside a `FOR SHARE` transaction would
deadlock two concurrent reuses. The revocations that take no user row lock
are `revokeSession`, which no application path calls, and
`revokeAllSessions`, the unlocked pass that a reset and a Google account claim
run before their locked transaction.

Two effects are accepted:

- A correct password still updates `last_logged_in_at` and still runs the
  platform auto-join, even when the re-read then answers 401. Both run after
  the password check and before the transaction. Inside it, the auto-join's
  own transaction (the platform-tenant lookup, then membership and audit
  inserts whose foreign keys take `FOR KEY SHARE`) would run while the user
  row is held `FOR SHARE`, lengthening that lock.
- The session denylist (Redis) is written after the transaction commits. If
  that write fails, the request still succeeds: the password is changed and
  the refresh tokens are revoked. One `error` line
  (`session denylist write failed after revocation`, for a reset too, for
  `revoke-others`, and for a staff deactivation, sign-out or deletion)
  records the user id and the number of sessions not denied. The revoked
  sessions' access tokens then stay valid until they expire
  (`ACCESS_TOKEN_TTL`, 15 minutes by default). That is the same exposure as
  the denylist failing open during a Redis outage. A stalled Redis does not
  lose the write: the request waits for it at most 300 ms, and a write still
  in flight then lands when Redis answers.

### User enumeration: closed on `/login` and `/register`

**Scope this claim to the endpoint.** What follows is a property of
`POST /api/v1/auth/login` and `POST /api/v1/auth/register`. Neither reveals
whether an address is registered — register at the cost of one accepted
residual timing difference (below), not zero cost.

#### `/login`: identical responses, identical timing

`login` (`src/services/auth.service.ts`) answers an unknown email and a wrong
password for a real account with the same status (401), the same body
(`"Invalid email or password"`), and the same cost. Returning the same body
while skipping the bcrypt comparison for an unknown email would still leak
which addresses are registered, through response **timing**: a real password
check pays for a full bcrypt compare. `getDummyHash()` closes that gap: when
no user row matches, login still runs one real `isPasswordValid` comparison
against a fixed dummy hash, hashed at the same `BCRYPT_COST` every real
password uses. A deactivated account (`active: false`) and a Google-only
account with no password are rejected the same way, after the same
comparison, through the same error.

**An unverified account is rejected the same way, and the message is
deliberately misleading.** The same combined guard rejects any account whose
`emailVerifiedAt` is still null, so an unverified account gets the identical
`401` body and the identical bcrypt cost a wrong password would. `'Invalid
email or password'` is, in this case, literally false: the credentials are
correct, the account has not clicked its verification link yet. A truthful
"this account exists but isn't verified" would confirm both that the address
is registered and that the submitted password is right, to anyone trying
credentials against it. The cost is real: a user who registered and has not
checked their inbox sees the same error a mistyped password produces, and
files a support ticket that says "login is broken". That ticket is the
accepted cost of not handing an attacker a working oracle.

#### `/register`: closed by an identical response, not by a rate limit

`POST /api/v1/auth/register` answers **every** request identically — `202`,
`'If that address can be registered, a verification email has been sent.'`,
`data: null` — whether the address is free or already taken. The repository's
unique-violation-to-409 translation still fires on the duplicate; `register`
catches that specific failure and proceeds to the same response. What differs
between the two branches is invisible to the caller: a free address gets a
verification-link email; a taken address gets a "someone tried to register
with your address" notice addressed to the account's **stored** name, never
the submitted one. Nothing is overwritten on the taken branch — see "Email
verification" below for why that matters. The reply goes out before either
mail is enqueued.

The taken-address notice is sent at most once per
`REGISTRATION_ATTEMPT_NOTICE_COOLDOWN` (1 hour by default) per address:
`sendRegistrationAttemptMail` claims a per-address slot in Redis (`SET NX PX`,
keyed by `hashRateLimitIdentity` of the trimmed, lowercased address) before
queuing it. Without it anyone could mail-bomb an account owner through
`/register` (the IP limiter allows 100 an hour from each address). There is
deliberately no per-address 429 on `/register`: it would tell a caller the
address is taken. When Redis is down the notice is skipped: it is a notice,
not a way back into the account.

**Residual timing, accepted.** Both branches pay one full bcrypt hash —
`hashPassword` runs before the insert whether or not the row is kept — so the
two branches differ only inside one transaction: a taken address stops at the
failed user insert and rolls back, a free one runs two more `auth_providers`
statements and commits. That is on the order of a millisecond against a
~250ms bcrypt cost. That gap is dominated by ordinary network jitter and is
accepted rather than engineered away.

What still constrains this endpoint is its limiter below: 100 attempts per
hour from one IP. It bounds bcrypt CPU exhaustion and outbound mail volume,
since every accepted request can send an email down one branch or the other.

### Email verification: the password requirement and the token-burn trade

`POST /api/v1/auth/verify-email` takes `{ token, password }`, not the token
alone. The second field is load-bearing — see the squatting scenario below.

**A wrong password burns the token.** `verifyEmail`
(`src/services/verification.service.ts`) claims the token row (`claimToken`,
which marks it consumed) **before** comparing the password, so presenting a
token is what spends it, correct password or not. A wrong password on a
genuine link fails exactly like an unknown token, and the link is then dead.
One link is one attempt. A legitimate typo costs the user a resend, not a
retry, and generates its own support tickets ("my verification link stopped
working"); that trade is deliberate.

**Why the token alone is not enough — the squatting scenario.** An attacker
registers `victim@example.com` with a password of their own choosing. The row
now exists, unverified. The harmful step is always the same one:
`emailVerifiedAt` getting written at click time on a row whose password the
clicker did not set. If verification accepted the token alone, both candidate
policies for a taken-but-unverified address end in a silent takeover:

- _Overwrite the password (newest registrant wins)_ — when the **victim**
  registered first and has not yet clicked, the attacker's registration
  overwrites the victim's password, and a fresh verification link goes to the
  victim's inbox. The victim's own click then verifies the address with the
  attacker's credentials.
- _Write nothing on the taken branch_ (what ships) — `resend-verification`
  still mails the victim a live link for the attacker's row, and the victim's
  own click verifies the address the **attacker's** password is sitting on.

Requiring the password in the verify call closes both: the attacker knows the
password but can never produce the mailed token; the mailbox owner can
produce the token but not the attacker's password. Neither half can complete
verification alone.

**The owner recovers a squatted address through password reset.**
`POST /api/v1/auth/forgot-password` mails a reset link to the address, and
`resetPassword` (`src/services/auth.service.ts`) treats a completed reset as
proof of mailbox control: on an account that was never verified, it deletes
any federated sign-in linked to the row, sets the new password, and sets
`emailVerifiedAt`, all in one transaction, and revokes every session. The
attacker's password stops working; the owner holds the account.

**Accounts loaded from elsewhere.** `login` refuses any account whose
`email_verified_at` is null. Rows written into `users` by anything other than
this API's own flows — an import from an existing system, for example — have
it null, so every one of those users is locked out until it is set. Set it
before they sign in:

```sql
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
```

That treats every such account as verified. Run it only for accounts whose
addresses the source system already trusted.

### Rate limiting: one store prefix per limiter

`RATE_LIMITS` (`src/constants/rate-limit.constants.ts`) holds 30 limiter
specs, each built into middleware by `createRateLimiter(spec)`
(`src/middlewares/rate-limit.middleware.ts`). Sixteen guard the auth router
(every route on it except `GET /providers` has at least one), seven guard
tenant creation, member invitation, invitation preview and accept, staff
reads, staff timelines and staff writes, two guard the email webhook, one
guards the PostHog proxy, one guards the feature-flag exposure reports, one
guards the public maintenance status, one guards the maintenance-mode change,
and `authenticatedWrite` covers every other authenticated write. Paths below
are under `/api/v1`; a `user` key is the authenticated user's id, and an
`email (HMAC)` key is a keyed digest of the submitted `email`, trimmed and
lowercased (below).

| Route                                                                                                                                                                                                                                                                                                                                                                                                                                      | Limiter (`rl:` prefix)                           | Limit                                             | Key                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- | --------------------------- |
| `POST /auth/register`                                                                                                                                                                                                                                                                                                                                                                                                                      | `register`                                       | 100 per hour                                      | IP                          |
| `POST /auth/login`, in this order                                                                                                                                                                                                                                                                                                                                                                                                          | `login`                                          | 5 per 15 minutes                                  | IP + submitted email (HMAC) |
|                                                                                                                                                                                                                                                                                                                                                                                                                                            | `login-ip`                                       | 100 per 15 minutes                                | IP                          |
|                                                                                                                                                                                                                                                                                                                                                                                                                                            | `login-account`                                  | 100 per hour (refused, well-formed attempts only) | email (HMAC)                |
| `POST /auth/refresh`                                                                                                                                                                                                                                                                                                                                                                                                                       | `refresh`                                        | 300 per 5 minutes                                 | IP                          |
| `POST /auth/logout`                                                                                                                                                                                                                                                                                                                                                                                                                        | `logout`                                         | 300 per 5 minutes                                 | IP                          |
| `POST /auth/verify-email`                                                                                                                                                                                                                                                                                                                                                                                                                  | `verify-email`                                   | 30 per 15 minutes                                 | IP                          |
| `POST /auth/resend-verification`                                                                                                                                                                                                                                                                                                                                                                                                           | `resend-verification-ip`                         | 5 per hour                                        | IP                          |
|                                                                                                                                                                                                                                                                                                                                                                                                                                            | `resend-verification-email`                      | 20 per hour                                       | email (HMAC)                |
| `POST /auth/forgot-password`                                                                                                                                                                                                                                                                                                                                                                                                               | `forgot-password-ip`                             | 5 per hour                                        | IP                          |
| `POST /auth/reset-password`                                                                                                                                                                                                                                                                                                                                                                                                                | `reset-password`                                 | 10 per 15 minutes                                 | IP                          |
| `POST /auth/change-password`                                                                                                                                                                                                                                                                                                                                                                                                               | `change-password`                                | 5 per 15 minutes                                  | user                        |
| `POST /auth/sessions/revoke-others`                                                                                                                                                                                                                                                                                                                                                                                                        | `revoke-other-sessions`                          | 10 per hour                                       | user                        |
| `GET /auth/google` (when Google sign-in is on)                                                                                                                                                                                                                                                                                                                                                                                             | `google-oauth`                                   | 300 per 5 minutes                                 | IP                          |
| `GET /auth/google/callback` (same)                                                                                                                                                                                                                                                                                                                                                                                                         | `google-oauth-callback`                          | 300 per 5 minutes                                 | IP                          |
| `POST /tenants`                                                                                                                                                                                                                                                                                                                                                                                                                            | `create-tenant`                                  | 20 per hour                                       | user                        |
| `POST /tenants/:slug/invitations`, `POST …/invitations/:id/resend`                                                                                                                                                                                                                                                                                                                                                                         | `invite-tenant-member`, one shared budget        | 30 per hour                                       | user                        |
| `POST /invitations/preview`                                                                                                                                                                                                                                                                                                                                                                                                                | `invitation-preview`                             | 60 per 15 minutes                                 | IP                          |
| `POST /invitations/accept` (after `requireAuth`)                                                                                                                                                                                                                                                                                                                                                                                           | `invitation-accept`                              | 20 per 15 minutes                                 | user                        |
| `POST /auth/reauthenticate` (after the staff check)                                                                                                                                                                                                                                                                                                                                                                                        | `reauthenticate`                                 | 5 per 15 minutes                                  | user                        |
| `GET /platform/tenants`, `GET /platform/tenants/:id`, `GET /platform/users`, `GET /platform/users/:id`, `GET /platform/stats`, `GET /platform/flags`, the `/platform/emails*`, `/platform/email-suppressions`, `/platform/onboarding/*` and `/platform/tenants/:id/onboarding` reads and `GET /platform/maintenance-mode` (after the staff check), and `GET /platform/system/status` and `GET /platform/audit-log` (after the admin check) | `platform-search`, one shared budget             | 60 per minute                                     | user                        |
| `GET /platform/users/:id/timeline`, `GET /platform/tenants/:id/timeline`, their Errors views and `GET /platform/flags/evaluate` (after the admin check)                                                                                                                                                                                                                                                                                    | `platform-timeline`, one shared budget           | 20 per minute                                     | user                        |
| Every `/platform` write (after the staff check)                                                                                                                                                                                                                                                                                                                                                                                            | `platform-write`, one shared budget              | 30 per minute                                     | user                        |
| `POST /webhooks/email/:provider`, in this order (public; the provider is checked first)                                                                                                                                                                                                                                                                                                                                                    | `email-webhook-rejected` (failed responses only) | 60 per minute                                     | IP                          |
|                                                                                                                                                                                                                                                                                                                                                                                                                                            | `email-webhook` (accepted requests only)         | 3000 per minute                                   | provider                    |
| `POST /flags/exposures`, `POST /tenants/:slug/flags/exposures`, `POST /platform/me/flags/exposures`                                                                                                                                                                                                                                                                                                                                        | `flag-exposure`, one budget on Redis             | 60 per minute                                     | session (`sid`), else user  |
| `GET /status/maintenance` (public)                                                                                                                                                                                                                                                                                                                                                                                                         | `maintenance-status`                             | 120 per minute                                    | IP                          |
| `PUT /platform/maintenance-mode` (after the owner and step-up checks)                                                                                                                                                                                                                                                                                                                                                                      | `maintenance-mode-change`                        | 10 per minute                                     | user                        |
| `/collect/*`, every method (public; the PostHog proxy)                                                                                                                                                                                                                                                                                                                                                                                     | `analytics-proxy`                                | 3000 per minute                                   | IP                          |
| Every other authenticated write (below)                                                                                                                                                                                                                                                                                                                                                                                                    | `authenticated-write`                            | 60 per minute                                     | user                        |

`platform-timeline`'s limit is `TIMELINE_REQUESTS_PER_MINUTE` (20 unless set).

Each spec is backed by its **own** `SharedRateLimitStore`
(`src/configs/rate-limit-store.config.ts`) under the key prefix `rl:<name>:`,
inside `REDIS_KEY_PREFIX` (so `<prefix>:rl:login:` in Redis). No limiter can
spend another's budget, so a 429 from any limiter but `authenticatedWrite` is
a statement about the endpoint that returned it. A new spec takes its own
name; `tests/unit/constants/rate-limit.constants.test.ts` fails if two
collide. The reasoning behind each limiter's window, limit and key lives on
its entry in `RATE_LIMITS`. A 429 carries the error envelope with code
`RATE_LIMITED` and the standard `RateLimit-*` headers.

**No address is a key name.** An email-keyed limiter writes a key for any
string submitted, account or not. So the address in it (and in `login`'s
composite key, in the mail cooldowns and in the invitation recipient ceiling)
is `hashRateLimitIdentity`: HMAC-SHA256 under a key derived from
`SESSION_SECRET` by HKDF with the label `rate-limit-identity-v1`, first 32 hex
characters (`src/utilities/rate-limit-key.utilities.ts`). Limits behave
identically; an operator can't read an address off a key, and nobody without
the secret can test a guessed address against one. Rotating `SESSION_SECRET`
restarts these counters.

The store starts in memory and switches to Redis once Redis answers, so the
limit is shared across replicas. Whenever a Redis command fails, that request
is counted in the store's own memory instead, and the next successful command
returns it to Redis. During an outage, then, counting is per process: with N
replicas, a client can make up to N× the limit. A Redis that is connected but
does not answer is handled as an outage, with the same cost for the limiters
and the session denylist: a request-path call that has not answered in 300 ms
fails, and for the next 5 s such calls fail without asking Redis.

- **Register** keys on the client's **IP alone**, deliberately not the
  composite login uses. Both threats here come from one caller varying the
  email, so any key containing the email would hand an attacker a fresh
  counter per request: enumeration changes the address by construction, and
  bcrypt CPU exhaustion does not care what the address is. `register` hashes
  at cost 12 (~250ms) before anything else, and bcrypt runs on libuv's
  threadpool (4 threads by default, shared with fs and DNS), so a few dozen
  concurrent registrations starve the whole process. Everyone behind one
  NAT'd address shares the counter, so the **limit** is what keeps an office
  of real people from locking each other out: 100 an hour sits far above any
  human signup rate and far below either attack. A 429 here delays a **new**
  signup and never locks anyone out of an **existing** account.
- **Login** keys its first limiter on the **composite** of IP and submitted
  email. Email alone would let anyone who knows a victim's address lock the
  victim out from anywhere; IP alone, at 5 attempts, would have everyone
  behind one NAT'd address share five. The composite does not stop a
  distributed attacker (many IPs, one account), so two more limiters follow:
  `login-ip` bounds one IP spraying many accounts, and `login-account` bounds
  every IP against one account. `login-account` counts only **well-formed
  attempts that were refused**: a body that fails the login schema (answered
  400 without a password check) and the owner's own successful sign-ins spend
  nothing, so password-less requests from a handful of IPs can't lock an
  owner, staff included, out of their correct password. **Residual, by
  design:** 100 well-formed wrong passwords an hour still lock the account.
  Each is a bcrypt-checked request, and the composite `login` key holds each
  IP to 5 per address. Attempts the first limiter rejects never reach the
  other two, so they spend neither budget. The email in each key is read from
  the raw body before validation, and no limiter checks whether it belongs to
  a real account, so the number of attempts before a 429 cannot probe which
  addresses are registered.
- **Refresh** is mostly volume protection: a raw refresh token is 256 bits of
  randomness, so guessing one is infeasible, and a replay past the grace
  window revokes the whole session. Within the grace window each replay of a
  stolen, already-rotated token mints a sibling, and this limiter caps how
  many an attacker can mint before the window closes. Each sibling is a second
  chain that lives until `SESSION_ABSOLUTE_TTL`, its session ends, or a
  password change or sign-out of other sessions from the real client's browser
  ends it (see "Refresh rotation and reuse detection"). The limit is generous
  because tightening it only costs real users retrying a flaky connection.
- **Logout** is unauthenticated by design (a user whose access token has just
  expired must still be able to end their session), so this limiter bounds
  the lookup and revoke an anonymous caller can drive. It closes no oracle:
  every logout answers 200. It is generous because a 429 answers **before**
  the handler runs and leaves the refresh cookie uncleared; it must never
  plausibly be the reason a real user cannot log out.
- **Forgot-password** has one limiter, `forgot-password-ip` (5 an hour per
  IP). A per-address limiter would let anyone who knows an address spend it
  and deny the owner their own reset mail. Instead, `requestPasswordReset`
  claims a per-address slot in Redis (`SET NX PX`,
  `PASSWORD_RESET_MAIL_COOLDOWN`, 5 minutes by default) before it looks the
  address up or queues a mail. The reply stays the same 202 for every request,
  so the owner's request is at most one cooldown late, and one address gets at
  most 12 reset mails an hour at the default. When Redis is down the mail is
  sent (fail open: the owner must be able to reset).
- **Invitation accept** authenticates first, then checks JSON, then counts
  per user. An IP key ahead of `requireAuth` would let anonymous requests from
  a shared address lock a signed-in invitee out, and in maintenance a refused
  customer would get a 415 or 429 before the 503.
- **Every other authenticated write** — the tenant `PATCH`, the member `PATCH`
  and `DELETE`, leaving a tenant (`DELETE /tenants/:slug/membership`), the
  invitation `DELETE`, the settings `PATCH`, the four notification writes, and
  `PATCH /api/v1/profile` — carries `authenticatedWrite`, after `requireAuth`,
  answering `429` with `Too many requests, please slow down`. A route with its
  own limiter keeps only that one. Each of the three routers (tenant,
  notification, profile) builds one instance and mounts it on each of its write
  routes. With Redis up, every instance counts under the same prefix and user
  key, so a client gets 60 such writes a minute in total, not 60 per route;
  during a Redis outage each instance counts in its own memory, so the budget is
  per router and per process. `tests/unit/routes/route-limiters.test.ts` walks
  the app's router and fails on any write route with no limiter that is not on
  its allowlist (empty), and on any `GET` route carrying `authenticatedWrite`.

There is no global limiter: a read is limited only where a route mounts one,
and most reads mount none.

**Notification streams** are capped twice, per process.
`SSE_MAX_STREAMS_PER_USER` (5) answers 429 `too_many_streams`, and
`SSE_MAX_STREAMS_TOTAL` (2000) answers 503 `stream_capacity` with
`Retry-After: 30`. Without the second cap, enough verified accounts at 5
streams each could hold every connection the proxy in front has: each proxied
stream costs nginx two (client and upstream), so an nginx worker with
`worker_connections 1024` is full at 512 streams, about 100 accounts' worth.
Size `SSE_MAX_STREAMS_TOTAL` per replica under what the proxy in front can
hold. Streams end at access-token expiry, and the client reconnects with
backoff.

### Deploying behind a proxy: `TRUST_PROXY` is a required decision

**If you deploy this behind an ingress, a load balancer, a CDN, or any
reverse proxy, you must set `TRUST_PROXY`. Leaving it unset is a real
misconfiguration, not a safe default.**

Every IP-keyed limiter above keys on `request.ip`. Express derives that from
the socket's peer address unless `trust proxy` is set — so behind a proxy,
the peer is the **proxy**, and `request.ip` is the same value for every
request. Every IP-keyed limiter then collapses into one bucket for the entire
deployment: refresh's "300 per 5 minutes" becomes 300 requests per 5 minutes
shared by all users, and a single noisy client denies refresh to everyone
else.

The opposite error is worse, and is why this is configuration rather than
something turned on by default. `X-Forwarded-For` is an ordinary request
header; anything that can reach the app can write whatever it likes into it.
Trust it too eagerly and a caller picks its own "client IP" on every request,
gets a fresh rate-limit bucket each time, and the login limiter stops
applying at all. **`TRUST_PROXY=true` is refused at boot** for exactly this
reason (`src/configs/env.config.ts`) — it is the value that gets typed by
accident, and every legitimate use of it can be written as a hop count or an
address list instead.

What to set:

| Deployment                                   | Value                                       |
| -------------------------------------------- | ------------------------------------------- |
| Clients reach the app directly               | `false` (the default)                       |
| Exactly one proxy in front (typical ingress) | `1`                                         |
| A known chain (e.g. CDN → load balancer)     | `2` — the number of hops you control        |
| Proxies on a known network                   | `10.0.0.0/8` (comma-separated list is fine) |
| Docker/compose networking only               | `uniquelocal`                               |

Count only the proxies **you** control. Each extra hop of trust is one more
position from which `X-Forwarded-For` can be forged. `createApp()` applies the
value at boot and a malformed one throws there, so a typo stops the process
rather than quietly disabling the limiters.

**`TRUST_PROXY` also decides whether the OAuth session cookie is sent.**
express-session only emits a `Secure` cookie when `req.secure` is true, and
behind TLS termination that needs `TRUST_PROXY` plus the proxy's
`X-Forwarded-Proto: https`. Otherwise the OAuth session cookie is silently never
set, and the Google OAuth `state` check fails. Boot logs a warning when
`COOKIE_SECURE` resolves to `true` and `GOOGLE_CLIENT_ID` is set while
`TRUST_PROXY=false`. The refresh cookie has no such dependency.

### Cookies: httpOnly, environment-derived `secure`, `sameSite: 'strict'`

The refresh token travels only in a cookie. Its name, path and domain come
from one function, `refreshCookieSpec` (`src/constants/auth.constants.ts`),
so every set, read and clear agrees. The auth controller gets the current
cookie only through its `currentRefreshCookie(env)`:

| Deployment                                | Name                    | Path           | Domain                   |
| ----------------------------------------- | ----------------------- | -------------- | ------------------------ |
| `COOKIE_SECURE` false (local http)        | `refreshToken`          | `/api/v1/auth` | `COOKIE_DOMAIN` when set |
| `COOKIE_SECURE` true, no `COOKIE_DOMAIN`  | `__Host-refreshToken`   | `/`            | none                     |
| `COOKIE_SECURE` true, `COOKIE_DOMAIN` set | `__Secure-refreshToken` | `/api/v1/auth` | `COOKIE_DOMAIN`          |

The browser enforces the prefixes, not this API. It refuses a `__Host-`
cookie unless it is `Secure`, host-only and on `Path=/`, and a `__Secure-`
one unless it is `Secure`. So neither can be planted over plain HTTP, and a
`__Host-` cookie can't be planted by a sibling subdomain either. A
`__Secure-` cookie can be: a page on any host under `COOKIE_DOMAIN` can set
one over HTTPS, since `COOKIE_DOMAIN` already trusts its subdomains. A plain
`refreshToken` can be planted both ways, so under `COOKIE_SECURE` the API
never redeems one (below). The cost of `__Host-` is `Path=/`: the browser sends
the cookie on every request to the origin, not only to `/api/v1/auth`. It is
still `HttpOnly`, `Secure` and `SameSite=Strict` (`Lax` when set by the Google
OAuth callback), so no script reads it and no cross-site `POST` carries it. A
deployment that wants it scoped to the auth routes sets `COOKIE_DOMAIN`, which
selects the `__Secure-` row.

**The unprefixed name is revoked, never redeemed.** With `COOKIE_SECURE` on, a
cookie named `refreshToken` (`LEGACY_REFRESH_TOKEN_COOKIE_NAME`) is one a
sibling subdomain or an on-path attacker on plain http can plant (cookie
tossing). Redeeming it would sign a signed-out browser into the planter's
session, which is login CSRF. So refresh reads only the current, prefixed name.
A refresh that carries only `refreshToken` revokes that cookie's session, clears
the cookie and answers 401. Logout, and a login or Google sign-in once it has
issued the new session, revoke the session of every distinct token the request
carries under either name (a Google callback, reached cross-site, carries no
`Strict` cookie; see "Refresh rotation and reuse detection"). Within one name
the API takes the most recently created value. When a login, a successful
refresh, a Google sign-in or a logout carried a `refreshToken` cookie, the
response clears it at `/api/v1/auth`: the host-only form, and the
`COOKIE_DOMAIN` form when that is set, skipping whichever form is the current
cookie itself. A browser that held only the pre-prefix cookie when the prefixes
shipped signs in once more. The revoke-and-clear read is removed at the next
major release. The OAuth session cookie takes the same prefix:
`__Host-oauth.sid` (`__Secure-oauth.sid` with `COOKIE_DOMAIN`), because a
planted `oauth.sid` would bind the victim's Google callback to the planter's
`state`.

Every form is set with:

- `httpOnly: true` — no script on the frontend origin can ever read the raw
  value.
- `secure: isCookieSecure(env)` — `COOKIE_SECURE` when it is set, otherwise
  `APP_ENV !== 'local'`. The rule lives only in `env.config.ts`, and the
  refresh cookie and the OAuth session cookie both use it. A hardcoded `true`
  would make cookie-based login impossible over plain HTTP in local
  development (browsers refuse a `Secure` cookie set over `http://`); a
  hardcoded `false` would ship a refresh token over an unencrypted connection
  in every other environment. `X-Forwarded-Proto` has no effect on this flag.
- `domain: COOKIE_DOMAIN` — omitted when unset, so the cookie is host-only.
  When it is set, the same domain goes on the set, the clear (a clear with a
  different domain leaves the old cookie in the browser), and the OAuth
  session cookie. On a secure deployment, turning `COOKIE_DOMAIN` on or off
  switches the cookie between `__Host-` and `__Secure-`, which signs every
  user in once. A leftover `refreshToken` is cleared by the next login,
  successful refresh, Google sign-in or logout that presents it. Changing it
  from one domain to another (or, on local http, unsetting it) leaves the old
  domain's cookie in the browser, which then sends two values under the same
  name, oldest first (RFC 6265 §5.4). The API reads the last, most recently
  created one, so the stale token never reaches reuse detection, and the old
  cookie expires within `REFRESH_TOKEN_TTL`. Reverting `COOKIE_DOMAIN` to an
  earlier value is the exception: an overwritten cookie keeps its original
  creation time (§5.3), so the other scope's cookie reads as newer and
  refresh fails until the user logs in again or that cookie expires.
- `sameSite: 'strict'` — the cookie half of this API's CSRF position (see
  below). The Google OAuth callback is the one exception: it sets the cookie
  with `'lax'`, because the browser reaches the callback by a cross-site
  redirect from Google, and a `'strict'` cookie set there would be withheld on
  the redirect to the frontend that follows. `'lax'` still withholds the
  cookie from cross-site `POST`s and subresource requests.

**`sameSite: 'strict'` assumes the frontend and this API share a registrable
domain (eTLD+1).** A deployment that splits the frontend and API across
different registrable domains never gets the cookie back at all, and needs
`'lax'` plus a CSRF token instead.

### Mass assignment: an explicit allow-list on profile updates

`PATCH /api/v1/profile` (`src/validators/profile.validators.ts`,
`src/services/profile.service.ts`) writes only the fields `updateProfileSchema`
names — `firstName` and `lastName` — no matter what else a request body
contains. `email`, `id`, `passwordHash` and `active` cannot be set through
this endpoint: the schema is a plain (non-`.strict()`) allow-list that
silently strips every unrecognised key rather than rejecting the whole
request, and `toUpdateValues` in the profile service only ever reads the two
keys that schema can produce. There is deliberately no second, independent
allow-list re-checking this, since a second definition is exactly what would
drift from the first.

### Free text rejects control, format and bidi characters

`safeText` (`src/validators/safe-text.validators.ts`) refines every free-text
field: the tenant `name`, `logo`, `website` and `description`, the settings
`timezone` and `locale`, `firstName` and `lastName` on register, profile and the
staff user create and edit, the maintenance message and reason, and every staff
`reason`. It rejects Unicode control characters (`Cc`: U+0000–U+001F and
U+007F–U+009F), every format character (`Cf`: the bidirectional marks,
embeddings, overrides and isolates, zero-width spaces, the word joiner, the byte
order mark, the soft hyphen, emoji tag characters, and the zero-width joiner and
non-joiner outside the places real text needs them) and the line and paragraph
separators (U+2028, U+2029). The joiners are allowed only where a script or an
emoji sequence needs them: a non-joiner (U+200C) between two letters or marks; a
joiner (U+200D) after a letter, mark, pictograph or skin-tone modifier and
before a letter, mark or pictograph, or after a Malayalam virama that follows a
letter. Each rejected character can make a stored name render as something else,
or as a lookalike of another, in an email, a log line or the UI; the cost is
that a direction mark inside a name is refused, and that a joiner or non-joiner
between two letters is allowed (`Ad\u200Dmin` and `Ad\u200Cmin` render as
`Admin`). Names are not unique-looking identifiers: they already accept
cross-script homoglyphs (a Cyrillic `а` in `Admin`), so an in-word joiner adds
no new kind of lookalike; identify an account by its id or verified address,
never by its display name. **Known limit:** invisible characters outside `Cf`
still pass, such as U+3164 (Hangul filler), U+034F (combining grapheme joiner)
and U+2800 (braille blank). `description`, the maintenance message and reason,
and a staff `reason` are multiline. They accept `\n` and `\t`, store `\r\n` as
`\n`, and reject a lone `\r`. A rejected field answers `400` in the usual
validation envelope, with a message naming the field
(`<Field> contains characters that are not allowed`; on the profile route, which
shares one rule for both names,
`This field contains characters that are not allowed`).

Fields with a known shape are checked against it too: `logo` and `website`
must be absolute `http:`/`https:` URLs (never `javascript:` or `data:`, so a
client that renders them as a link or image source runs nothing), with no
credentials (`user:pw@host`) and no backslash anywhere, so one host can't read
as another; each refusal says `<Field> must be an http or https URL.`
`timezone` must be a time zone name the runtime knows and `locale` a BCP 47
tag; settings `metadata` is at most 16 384 characters as JSON and 10 levels
deep. A `:slug` or member `:userId` that no stored row could match answers
`404` before any query, and a character Postgres cannot store that still
reaches it (SQLSTATE 22021/22P05) answers `400`, not `500`.

### Tenant invitations: consent, and no address enumeration

A user becomes a member of a tenant only by accepting an invitation. No route
adds a registered address to a tenant directly.

- **No enumeration.** `POST /api/v1/tenants/:slug/invitations` answers `202`
  with the same body whether or not the address has an account. The one
  distinguishable answer is `409 already_member`, and it only tells an owner
  or admin who is already in their own tenant. A registered and an
  unregistered address also take the same query path: the membership lookup
  runs either way (against a nil id when there is no account), and the in-app
  notification for a verified account is enqueued off the response path.
- **Consent.** Accepting (`POST /api/v1/invitations/accept`) needs a signed-in
  user whose verified email equals the invited address. A different address
  gets `403 invitation_email_mismatch`; the invited address, unverified, gets
  `403 invitation_email_unverified`. Either way nothing is claimed. A
  forwarded or leaked link is useless to anyone else.
- **Single use.** A token is 32 random bytes, base64url-encoded. Only its
  SHA-256 is stored. The claim is one atomic
  `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
  so of two concurrent accepts exactly one claims. The other succeeds only if
  it comes from the same user (idempotent). Resend replaces the token, so the
  old link dies, and revoke kills it outright. Links last `INVITATION_TTL`
  (default 7 days).
- **Where the token travels.** The only URL that ever carries it is the
  frontend page the email links to. The API takes it only in JSON bodies:
  `POST /api/v1/invitations/preview` and `POST /api/v1/invitations/accept`.
  So HTTP tracing, which records request URLs, and proxy access logs never
  see it on the API side. The frontend serves the accept page with
  `Referrer-Policy: no-referrer` (react-boilerplate's `nginx.conf`), so the
  page's URL doesn't leak onward as a `Referer`. The API sends the same header
  (helmet), but that covers only the API's own responses. The Vite dev server
  sets no such header. The token never appears in the database, the in-app
  notification, the list response or the application log.
- **Invite, resend and revoke re-check the grant matrix.** Invite, resend and
  revoke all apply `canActorGrantRole` to the actor's role re-read under lock:
  an admin can neither send, resend nor revoke an owner or admin invitation.
- **A pending invitation stands on its sender's authority.** Removing a
  member, or a member leaving, revokes every pending invitation they sent in
  that tenant, and changing their role revokes the ones the new role could not
  grant, in the same transaction, each with its own `invitation.revoked` audit
  entry under the actor of the change. On the platform tenant the same change
  also revokes, in every customer tenant, the invitations they sent there that
  their remaining authority cannot grant. Deactivating or deleting an account
  revokes its invitations in every tenant.
- **Rate limits:** preview is limited per IP; accept runs `requireAuth` first
  and is limited per user. See the table under "Rate limiting". Invitation
  mail is bounded three ways. Per sender: `invite-tenant-member`, 30 an hour,
  shared by invite and resend on the tenant routes. Per invitation: a resend within
  `INVITATION_RESEND_COOLDOWN` (10 minutes) of the last mail answers 429
  `invitation_resend_cooldown`; a staff resend through `/platform/emails`,
  which is audited with a reason, is exempt. Per recipient: at most
  `INVITATION_RECIPIENT_DAILY_LIMIT` (10) invitation mails to one address in 24
  hours across every tenant and sender
  (`rl:invitation-recipient:<hashRateLimitIdentity of the address>`, the keyed
  digest every email-keyed limiter uses), of which one tenant may send at most
  `INVITATION_RECIPIENT_TENANT_SHARE` (3). The tenant's share is counted first,
  and a send past it is refused without spending the address's count. Past
  either, the sender gets 429 `RATE_LIMITED`. The ceiling fails open when Redis
  is down. Staff owner invitations (at tenant creation, or to an ownerless
  tenant) are not counted. The cost: anyone with four or more tenants can
  still exhaust an address's day, so a legitimate inviter can be refused until
  the window ends; the inviter already knows the address, so the refusal
  reveals nothing.

### Leaving a tenant

A member leaves a tenant with `DELETE /tenants/:slug/membership`; any role may,
except the tenant's last owner (409 `LAST_OWNER`; the platform tenant counts
active owners). Staff reaching a tenant only through their platform role have
no membership to leave (404). Leaving revokes the leaver's pending invitations
there and is audited as `member.left`; leaving the platform tenant needs a
recent sign-in, as a self-removal there does.

### Platform staff access and the audit log

Staff are the members of one seeded tenant, the row with
`tenants.is_platform = true` (slug `platform`, a reserved slug). Their role
there is their **platform role**. There is no separate staff table and no
per-membership permission blob.

- **What staff can do in a customer tenant.** In a tenant they don't belong
  to, `resolveTenant` makes the platform role the effective role
  (`access: 'platform'`). It must clear the route's own `requireRole` bar and
  the service policies, and every write re-reads it under lock in its own
  transaction (`resolveActorAccess`, `src/services/tenant-access.service.ts`).
  A staff user demoted or removed mid-request can't finish on the old role.
  So:
  - a platform viewer can read but gets 403 on every write;
  - no platform role can change or remove an owner;
  - only a platform owner can change an admin, or grant owner or admin.

  Staff reaching a customer tenant through their platform role need a recent
  sign-in and a stated reason (1–500 characters) to change a member's role,
  remove a member, or send, resend or revoke an invitation there
  (`requireRecentAuthAndReasonOnPlatformAccess`). The reason is kept in the
  audit entry (`metadata.reason`). The services re-check it under the lock
  (`assertStaffReasonGiven`), so a membership deleted after the route's check
  still leaves a reason-less staff write refused 400 `REASON_REQUIRED`. A staff
  owner can still grant ownership this way; the dedicated
  `POST /platform/tenants/:id/owner-invitation` stays the path for an
  ownerless tenant.

  The one exception is a tenant with **no active owner**, one that staff
  created or whose owners are all gone or deactivated: a platform admin may
  invite its owner (`POST /platform/tenants/:id/owner-invitation`), because
  no member can. Only an active tenant qualifies; a suspended or archived
  one answers 409. The re-invitation needs a recent sign-in and a reason, and
  its audit entry records the invitee's account when the address has one,
  so an invitation a staff member sends to their own address is visible in
  the log.

- **Staff roles live on the platform tenant.** Its members are the staff, and
  its member routes are how staff roles change. There an owner may demote or
  remove another owner (and, under `/platform/users`, deactivate or delete one);
  the last-owner guard counts active owners only; and every invitation, whatever
  role it offers, a resend, a role change, a removal and leaving need a recent
  sign-in there: every platform role, viewer included, reads every user, tenant
  and email address, so a viewer invitation mints staff.
- **Membership wins.** Where a staff user is also a member, only the
  membership role counts.
- **The platform tenant is members-only.** Anyone who isn't a member of the
  platform tenant gets 404 there, and it never appears in staff search. A
  CHECK keeps it active and undeleted, and a partial unique index allows only
  one.
- **Joining.** A **verified** address whose domain is listed in
  `PLATFORM_EMAIL_DOMAINS` joins as `viewer`.
  - The domain is the exact part after the last `@`; subdomains don't match.
  - It happens when the address is verified, and on each successful sign-in
    after the credential check. A failed sign-in never joins, and a join
    error never fails a sign-in.
  - It never promotes or demotes an existing platform membership. Anything
    above viewer takes an invitation or `pnpm platform:grant`.
  - The list is empty by default. A compromised inbox on a listed domain gets
    read access to every customer tenant, so list only domains whose
    mailboxes you control.
- **Discovery.** `/api/v1/platform/*` answers non-staff, and staff below a
  route's role, with the app's own `404 Not found`, identical to an unknown
  route. The JSON gate and the limiters run after the role check, so a
  refused caller never sees a 415 or `RateLimit-*` headers. Every
  authenticated OPTIONS that reaches the platform router gets that 404 too
  (`refusePlatformOptions`), so Express's automatic `Allow` answer never
  lists a route's methods. `cors` answers an OPTIONS with no `Origin` or an
  allowed one itself, with the same 204 for every path, before any router;
  staff routes serve no cross-origin preflight of their own. An
  unauthenticated caller still gets 401, as on every authenticated router.
- **Cross-tenant reads are separate paths.** Only the platform services read
  `repositories/platform-tenant.repository.ts` (staff tenant search and
  detail), `repositories/platform-stats.repository.ts` (stats) and
  `repositories/platform-user.repository.ts` (the staff user directory, and
  the user purge), and a lint gate in `eslint.config.mjs` keeps it that way.
  `GET /tenants` still lists the caller's memberships only. `q` matches
  literally: `%`, `_` and `\` are escaped.
- **The audit log.** `audit_logs` records:
  - every tenant, settings, member and invitation change, in the same
    transaction as the change;
  - platform auto-joins and grants;
  - every staff action on a user or a tenant (`user.*`, `tenant.suspended`,
    `tenant.reactivated`, `tenant.archived`, `tenant.owner_invited`,
    `user.purged`, `tenant.purged`) and each staff step-up
    (`auth.reauthenticated`);
  - one `tenant.accessed_by_platform` row per staff user, tenant and hour.
    It's deduplicated in Redis; while Redis is down, every staff request
    writes one.

  Each action's metadata has a strict Zod schema. Invitation entries keep the
  role and the address's domain, never the address or the token.

  A `BEFORE UPDATE OR DELETE` trigger makes the table append-only for every
  role, with two exceptions: the retention purge below, and an owner's purge
  (an UPDATE that only nulls a purged user's actor columns, and a DELETE of
  a purged tenant's own entries, each inside its purge transaction). Its
  foreign keys are `ON DELETE RESTRICT`, so a hard delete that skipped those
  steps fails instead of erasing history. `TRUNCATE` is not blocked: a role
  with `TRUNCATE` privilege on the table — its owner by default, or a
  superuser — can still empty it, and the test suite relies on that.

  Retention is opt-in. `RETENTION_AUDIT_LOGS_DAYS` defaults to `0`, which
  keeps every row forever. Above 0, the daily purge deletes rows whose
  `occurred_at` is older than that many days. The trigger lets a DELETE
  through only in a transaction that set `app.audit_purge` to `on` and
  `app.audit_purge_before` to a cutoff after the row's `occurred_at` (a
  tenant purge sets `infinity`). It lets an UPDATE through only in a
  transaction that set `app.audit_redact` to `on`, and only when the update
  sets `actor_user_id`, `ip` and `user_agent` to NULL and changes no other
  column; every other UPDATE raises. Each purge sets its settings with
  `set_config(..., true)`, so they end with its transaction. Only
  `retention.service.ts` and `platform-purge.service.ts` name them, and
  `tests/unit/audit-purge-setting.test.ts` fails if any other TypeScript
  file under `src/` does. This guards against a stray `DELETE` or `UPDATE`
  in application code. It is not a privilege boundary: any role that can
  run arbitrary SQL can set the same settings. Revoke `UPDATE` and `DELETE`
  on `audit_logs` from every role except the one the app runs as.

- **Who reads it.**
  - `GET /api/v1/tenants/:slug/audit-log`: effective owners and admins, so a
    platform admin can read it and a platform viewer can't.
  - `GET /api/v1/platform/audit-log`: platform owners and admins only; anyone
    else gets the 404 above.

  Entries name the actor, staff included, with name and email, and
  `access: 'platform'` marks staff actions. Both reads filter by `access`
  (`member`, `platform` or `system`). The IP, user agent and request id are
  stored but never returned.

### The staff surface is gated per route, not by its prefix

Every staff route lives under `/api/v1/platform`. The prefix is only for
organisation: it doesn't secure anything, and neither does serving Apex from
its own host (OWASP API Security Top 10 2023, API5 Broken Function Level
Authorization; ASVS 5.0 8.2.1 and 8.4.2). Each route names its own
`requirePlatformRole`, which re-reads the platform role on every request,
and non-staff and staff below the route's role get the app's 404, before
the JSON gate, the step-up check and the limiter.
`tests/integration/api/platform-route-gates.test.ts` holds one row per
route, walks the platform router and its `/users`, `/emails`, `/email-suppressions`, `/onboarding` and `/tenants/:id/onboarding` sub-routers, and fails
when the router registers a route the table lacks or mounts a sub-router
it doesn't know. A customer-facing nginx may also refuse
`/api/v1/platform/` as defence in depth; that's an extra layer, never the
gate. Each successful `/platform` write the role gate admitted also logs
one `Staff write` line (method, path, status, actor id, and the target's
type and id when the path names one; never the body, so never a reason or
an address); a caller the gate refused can't produce one. The audit log
stays the record.

### Step-up for destructive staff actions

Deactivating, deleting or purging a user; suspending, archiving or purging a
tenant; re-inviting a tenant's owner; on the platform tenant, a role change, a
removal, leaving, a resend or any invitation, whatever role it offers; and, for
staff reaching a customer tenant through their platform role, a member's role
change or removal and an invitation's send, resend or revoke (each also takes a
reason) need a sign-in within the last 10 minutes (ASVS 5.0 7.5.3). An email
resend of any invitation (`POST /platform/emails/:id/resend`) needs it too, on
every tenant: the route cannot know the message's tenant, so the service checks
it with the same predicate, `isRecentAuth`, and passes the resend's reason on to
the `invitation.resent` entry. Marking a tenant's onboarding step complete and
sending its owners a reminder need no step-up: neither grants access, and each
takes a reason and is audited in the tenant. The refresh row records
`authenticated_at` when a session starts, rotation carries it forward unchanged,
and the access token carries it as `auth_time`. `requireRecentAuth` answers 401
`REAUTH_REQUIRED` when the claim is missing or older than `STEP_UP_MAX_AGE_MS`;
it runs after the route's role gate, so a caller below the route's role gets the
404 whatever their sign-in age. `POST /auth/reauthenticate` (staff only)
re-checks the password and moves the session's `authenticated_at` forward; a
wrong password is a 400, never a 401, and both a success and a wrong password
are audited (`auth.reauthenticated`). Step-up is password-only: an account with
no password (Google-only) gets a 400 asking it to set one first. Clients must
not sign out on `REAUTH_REQUIRED`.

### Staff actions carry a reason

Every staff state change records who acted, on what, and why: deactivate,
reactivate, sign-out, delete and purge a user; suspend, reactivate, archive and
purge a tenant; re-invite its owner; resend an email; lift an email suppression;
and, through platform access to a customer tenant, change a member's role,
remove a member, or send, resend or revoke an invitation. The `reason` (1–500
characters, safe text) is stored in the audit entry's metadata and shown in the
platform activity log. A tenant's own members see the entry in their audit log,
but not the staff member's reason. Staff never set a user's password: a
staff-created account gets a single-use set-password link that expires after
`ACCOUNT_SETUP_TTL` (ASVS 5.0 6.4.6).

### Purge: the only hard delete

Deleting a user or archiving a tenant is soft: the row stays and can be
inspected. A platform owner can then purge it for good (`POST
/platform/users/:id/purge`, `POST /platform/tenants/:id/purge`), with
step-up and a reason. A user purge removes the row and erases them from the
audit entries they acted in: `actor_user_id`, `ip` and `user_agent` become
NULL, under a trigger exception that allows exactly that UPDATE and nothing
else (migration 0019). Mail log rows and invitations hold the address and
are matched by it alone, and a deleted user's address can be claimed again.
So when a live account holds the address, the purge deletes none of them
(it can't tell the purged user's from the new holder's); otherwise it
deletes those created up to the user's deletion and keeps any written
after. The actor CHECK (`audit_logs_actor_user_check`) only
requires a `system` entry to have no actor id, so a redacted entry keeps
`actor_kind = 'user'` with its actor id NULL; the database can't tell a
redacted entry from a user entry written without an actor. A tenant purge
removes the tenant and its own audit entries. Each purge is recorded in the
platform tenant (`user.purged`, `tenant.purged`).

**What a purge does in PostHog.** A user purge queues the deletion of their
PostHog person with its events and recordings (`analytics_deletions`,
written in the purge's transaction) and deletes their undelivered outbox
rows, so nothing of theirs is sent afterwards to recreate the person; the
job deletes any that arrived since just before it calls PostHog. The
`analytics-deletions` job sends it an hour later, because PostHog deletes
only events it ingested before the request, and retries until PostHog has
queued it; PostHog then deletes in the background. It needs
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`: without them the rows
wait, and boot warns while any do. Recording removal rests on PostHog's
documented `delete_recordings` flag. A tenant purge cannot delete the
PostHog group, so it queues a `$groupidentify` marker that the drainer sends
as `{ name: null, status: 'purged' }`, clearing the name. These stay in
PostHog: the `user_purged` event's `email_domain`, which is the acting
owner's event, not the purged user's; staff events about the purged user
(`target_id` is their id), which belong to the staff who acted; and a
purged tenant's group key and `created_at`, and its events, which are keyed
by the tenant id and carry no name.

### Email tracking: what is stored, and what a resend can do

An `email_messages` row keeps only its template's `previewVariables`, which
can never name a `…Url` or `…Token` key: the type forbids one, the
repository refuses one before the insert, and a check at module load covers
every template. No rendered body, link or token is stored, and an
invitation's inviter name is left out, so purging the inviter leaves
nothing of theirs behind. A provider event keeps a short UPPER_SNAKE
`detail` under a CHECK, never a raw payload or a clicked URL. The staff
preview re-renders with every token masked.

The webhook route is public, so each adapter verifies the provider's
signature over the raw body before reading it (Resend: Svix, a 5-minute
timestamp tolerance, a constant-time compare); a failure is a 401 logged
without the payload. Two limiters guard it. `emailWebhook` is keyed per
provider, not per IP, and counts only accepted requests, so a bounce storm
from a provider's few egress addresses is not throttled into retries and
unsigned traffic cannot spend its budget. `emailWebhookRejected` is keyed per
IP and counts only failed responses (60 a minute), which caps forged traffic
from one address.

Token emails always use the transactional sender class
(`MAIL_FROM_TRANSACTIONAL`), which the operator must put on a domain with
click tracking off so no provider redirector sees a live link; unset, it
falls back to `MAIL_FROM` and boot warns outside local. No caller can
choose the sender.

A staff resend runs the action that sent the mail and issues a new token;
it never sends a stored one, and it reaches only accounts and invitations
the staff member could act on through that action (the rank rule for user
mail, `canActorGrantRole` for invitations). The `canResend` flag on the
list and detail is a hint computed with the same predicates; the endpoint
enforces them again. The two security notices are never resent, since a
replay would report an event that did not happen again. No mail bypasses
the suppression list, and lifting a suppression needs an admin, a reason
and an audit entry.

### Analytics: what reaches PostHog

With `POSTHOG_PROJECT_KEY` set, the API sends PostHog server events and
proxies the browsers' posthog-js traffic; without it, neither happens.

- **The proxy carries no credential.** `/api/v1/collect/*` (which also
  carries the browsers' `$exception` batches) is on the API's
  origin, so the browser sends it the `__Host-refreshToken` cookie
  (`Path=/`) like any other request. The proxy removes the `Cookie` and
  `Authorization` headers before the request leaves, so PostHog never
  receives a session (`analytics-proxy.test.ts`).
- **The client address is the one Express resolved.** `X-Forwarded-For`
  upstream is `request.ip` under `TRUST_PROXY`, not a header the client
  sent (`X-Forwarded-Host`, `-Proto` and `-Port` are overwritten too), so a
  client cannot choose the address PostHog geolocates.
- **PostHog cannot set cookies or CORS on the API's origin.** The proxy
  drops the upstream's `Set-Cookie`, which could overwrite the `Path=/`
  refresh cookie, and its `Access-Control-*` headers, so the app's own CORS
  decision stands. A silent upstream is cut off with a 504 after 30 s.
- **The proxy is not an open relay to anywhere:** it reaches only the
  configured PostHog ingest and assets hosts, under its own per-IP limiter
  (`analytics-proxy`, 3000 a minute). Bodies stream unread and unbounded,
  as replay chunks need; PostHog bounds what it accepts.
- **Server events carry ids, never names or addresses.** Names, full
  addresses, staff reasons, email subjects, recipients and provider details
  never go into an event; the tenant name goes only into the tenant group's
  properties. The one exception is an address's domain: invitation, auto-join,
  user and email audit events carry `email_domain`, and
  `onboarding_reminder_sent` carries `email_domains`. `distinct_id` (a user id)
  and `$session_id` are pseudonymous identifiers, not anonymous ones: they
  identify a person to anyone who can look the id up. A user purge deletes
  the person and their events from PostHog (see "Purge: the only hard delete").
- **Accepted risk: a client chooses its own trace ids.** The API parents a
  request's span on the `traceparent` header the frontends send, and events
  carry that `trace_id`. A trace id is a correlation key only and never
  authorizes anything.
- **Browser events are client-reported; server events are signed.** The
  project key is public, so anyone can send PostHog any event, under any
  `distinct_id` or `target_id`. The drainer adds `server_sig` to every server
  event (an HMAC keyed from `SESSION_SECRET`, `analytics-signature.service.ts`),
  and the staff timelines present a row's `source`, `access` and target only
  when it verifies: an unverified row is shown as a browser event, and one
  that reaches a timeline only through a forged target is dropped.
  **Accepted risk:** PostHog's own UI still shows forged events, and a flood
  of forged events can push real rows onto later timeline pages.

### Error tracking: what reaches PostHog

With `POSTHOG_PROJECT_KEY` set and `ERROR_TRACKING_ENABLED` true, an
unexpected 5xx, an uncaught exception or unhandled rejection, and a BullMQ
job's final failure each send one `$exception` straight to PostHog's
`/batch/`, not through the outbox, because an error often arrives while the
database is down.

- **Scrubbed before it leaves the process.** Every exception's type and
  message, and every frame's file and function name, pass through
  `error-scrubber.service.ts`. A query error's value is exactly `Failed
query`: the SQL text is never sent. A thrown object that is not an `Error`
  (and holds none) is sent as an error named for its class (`Error` for a plain
  object) with the fixed value `Non-Error object thrown`: its keys and values,
  which can be user input, are never sent. The rule families are Postgres
  `Key (col)=(value)` detail, Postgres and JSON input echoes, URL logins,
  query strings, fragments (a line anchor such as `#L5` and a lowercase heading
  such as `#getting-started` are kept), Bearer, Basic and known-scheme
  Authorization credentials, every parameter of an Authorization header (any
  scheme, Digest and OAuth included) and of a Cookie line, to the end of the
  line; `key=value` secrets (plural keys, array values, `=>` and URL-, HTML- or
  JSON-encoded separators, `sig`, `hmac`, `nonce`, `response`, `pin`,
  `passphrase` and the one-time code names, and compound key names such as
  `secret_key` before `:` too; only the bare values `undefined`, `null`,
  `missing`, `true` and `false`, and already-scrubbed placeholders, are kept);
  `code` only where it reads as an authorization code: after `?` or `&`,
  before a further `&` field (`code=…&`), with `oauth`, `authorization` or
  `authorize` earlier on its line or later on it with no brace in between, or anywhere in
  a text that names an OAuth exchange (`grant_type`, `redirect_uri`,
  `client_id`, `authorization_code`, `code_verifier`, `invalid_grant` or
  `oauth`); `key` only before `=`; JWTs, PostHog keys, Google, Resend, AWS,
  Slack and Stripe-style keys, email addresses (including unicode, `%40`,
  `%2540`, fullwidth `＠`, quoted local parts, IP-literal and single-label
  domains), IP addresses, `+`-prefixed phone numbers, the token segment after
  `/reset/`, `/verify/`, `/invite/` or `/accept/`, and long hex and base64
  runs. Each value is then capped at 1024 characters. The span that records
  the exception (`span.recordException`) gets the same scrubbed name, message
  and stack, so Tempo never holds the raw message either. The frontends port
  the same rules, tested against one shared vector file. The reporter's own
  failure warning logs the thrown value's kind and its scrubbed text, never
  the value.
- **Slack gets the same scrubbing.** When `SLACK_WEBHOOK_URL` is set, every log
  record at or above `SLACK_LOG_LEVEL` (default `error`) is forwarded, and its
  message, source, request id and stack pass through the same `scrubText` before
  the webhook call: each frame line on its own, so frame paths stay readable,
  and each run of other lines as one text. So does the duplicate summary. The
  time is validated, not scrubbed: only an ISO 8601 instant is sent, else the
  current time. A record whose scrub throws is replaced by a fixed notice that
  carries nothing from it. Duplicates are keyed on the raw source and message,
  which never leave the process.
- **What the scrubber does not catch:** names and other free text; ids, UUIDs
  included, which are identifiers rather than secrets and are kept on purpose
  because they help debugging; national-format phone numbers without a leading
  `+`; a bare opaque word with no key in front of it; a `code` value outside the
  contexts above, and a `key` value written with `:`, both kept so
  `code: 'ECONNREFUSED'` and `key: 'user_id'` stay readable (an `oauth` inside
  any word, `myoauthlib` included, counts as OAuth context, so every `code` key
  in that text is redacted); a bare `response:` followed by unquoted prose
  (`Unexpected response: 502`); an Authorization header on its own, which does
  not make a `code` on another line an authorization code; the text after a
  Bearer or Basic credential on an Authorization line (`Bearer [token] extra`
  keeps `extra`); a nested array value past its first `]`; a camelCase `pin`
  (`userPin`); a key behind a double-encoded quote or separator (`%2522`,
  `%253D`) or a hex HTML entity (`&#x3D;`), and a `key` after an encoded `&`
  (`%26key%3D`); a URL fragment of lowercase letters and hyphens with no
  key-like word (`#api-key` and `#token-abc` are replaced): under 40 characters,
  or up to 64 when each hyphen-joined word has at most 20 letters, which reads
  as a heading; a kebab- or snake-case run of lowercase words of up to 20
  letters each, 40 or more characters in all, which reads as an identifier;
  vendor tokens with no rule (`ya29.`, `glpat-`, `hf_`, Google `1//` refresh
  tokens); a host named like a package ref after `@` (`jane@main`, `jane@npm:`,
  `jane@workspace:`); the domain of an email whose local part is a JWT
  (`[jwt]@example.com`); and the part before the last `/` of a secret glued to
  an email address (`abc/def/ghi@example.com` keeps `abc/def/`). Scrubbing a
  scrubbed text again changes nothing, except a URL fragment the base64 rule
  replaced (`#[secret]` becomes `#[fragment]`) and contrived inputs that glue a
  phone number, address or hex run to one another. Regex scrubbing is
  best-effort: keep secrets out of error messages.
- **Never attached:** request bodies, headers, query strings or cookies;
  a database error's `detail`, `parameters`, `query` or `where`, or the
  bound values a failed query's message embeds; a job's data; an
  `HttpError`'s `errors`. The event names the route by its template
  (`/api/v1/platform/users/:id`), never the URL
  (`error-tracking.test.ts` sends a postgres.js unique violation and checks
  the address is absent).
- **What is not reported:** any 4xx, a client that went away, a deliberate
  `HttpError` 5xx with no `cause`, a `TimelineUnavailableError`, a job
  attempt BullMQ will retry, and the `/collect` proxy's own failures.
- **`$exception` events are signed too.** The reporter adds `server_sig`
  over the same fields as every server event, with `source: 'error'`. The
  staff Errors views verify the most recent event of each issue and show
  an issue claiming `app: 'api'` without a valid signature as unverified;
  they scrub its type and message again before returning them, because a
  forged browser event can carry anything. They drop a row whose issue id
  is not a UUID, and ignore events stamped more than 5 minutes ahead of now.
  **Accepted risk:** PostHog's own Error Tracking UI shows forged exceptions
  alongside real ones, and a forged event newer than an issue's real ones can
  still mask that issue's latest type and message in the staff view, which
  then shows the row `verified: false`.
- **Identity.** An error during an authenticated request carries the user's
  id and tenant group, as their other events do. Anything else is sent as
  `server:<OTEL_SERVICE_NAME>` with `$process_person_profile: false`.
- **`errorId` is not a secret.** Every 5xx body carries it so a user can
  quote it; it is the event's uuid and names a log line (a timeline 502's names
  nothing), and grants nothing.
- **`/health` is public and names the release.** It answers the image's git
  sha (`APP_VERSION`). That is harmless for this public boilerplate; a
  private fork that treats its sha as sensitive drops the field in
  `src/app.ts`.

## What this boilerplate does NOT implement

None of these is built, except where the Status column says Partial:

| Control                                               | Status              | What that means for you                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MFA                                                   | **Not implemented** | No TOTP enrolment and no recovery codes. The one step-up is a password re-check before destructive staff actions; see "Step-up for destructive staff actions".                                                                      |
| CSRF tokens                                           | **Not implemented** | See "No CSRF middleware" below — reasoning, not an oversight. The forced-login direction IS defended, by a content-type gate; see the section after it.                                                                             |
| General-purpose rate limiting                         | **Partial**         | 30 limiters (see "Rate limiting" above). Every write route has one, at least the shared `authenticatedWrite`. There is no global limiter, and authenticated reads (profile, notifications, tenant reads, the audit logs) have none. |
| Rehash on login                                       | **Not implemented** | See "Password hashing".                                                                                                                                                                                                             |
| Impersonation, break-glass access, row-level security | **Not implemented** | Staff act only through the platform role; see "Platform staff access and the audit log".                                                                                                                                            |
| Audit of sign-in and credential events                | **Partial**         | `audit_logs` records no login, logout, password change or password reset. The one sign-in event it records is a staff step-up (`auth.reauthenticated`, success or wrong password).                                                  |
| Session list                                          | **Not implemented** | `POST /auth/sessions/revoke-others` ends every other session (as a password change does), and a staff admin can end all of a user's sessions.                                                                                       |
| Email change, account deletion                        | **Not implemented** | No endpoint changes a user's email or deletes their own account. `PATCH /api/v1/profile` sets only `firstName` and `lastName`.                                                                                                      |
| OpenAPI documentation                                 | **Not implemented** | No spec is generated or served.                                                                                                                                                                                                     |
| Seed data                                             | **Not implemented** | No seed script. `pnpm platform:grant` grants a platform role to an existing, verified user.                                                                                                                                         |

The schema's required secrets and public URLs are all read. `JWT_ACCESS_SECRET`
signs and verifies access tokens (`signAccessToken`/`verifyAccessToken`).
`SESSION_SECRET` signs the session cookie of the Google OAuth round-trip
(`src/configs/passport.config.ts`; `__Host-oauth.sid` with `COOKIE_SECURE`,
`__Secure-oauth.sid` when `COOKIE_DOMAIN` is also set, plain `oauth.sid` without
`COOKIE_SECURE`). It also keys, through HKDF-SHA256 with the label
`rate-limit-identity-v1`, the HMAC that turns an email address into a rate-limit
key (`src/utilities/rate-limit-key.utilities.ts`), so no rate-limit key carries
a submitted address. `APP_URL` builds the Google callback URL (same file), and
boot refuses a `COOKIE_DOMAIN` that `APP_URL`'s host is not within
(`src/configs/env-consistency.config.ts`). `WEB_URL` builds the mailed links and
the OAuth redirects, and `origin.utilities.ts` (see "CORS" below) decides from
it, `APEX_URL` and `CORS_ALLOWED_ORIGINS` whether a browser's `Origin` gets a
grant. There is no `JWT_REFRESH_SECRET` at all (see "Authentication" above).

**Frontend choice is an enum.** A request may say which frontend a link or
OAuth redirect is for (`app: 'web' | 'apex'`), never where it goes; the
origin comes from `WEB_URL` or `APEX_URL`. A bad `app` is a 400 on `register`
and `forgot-password`, the usual 202 on `resend-verification`, and `'web'` on
`/auth/google` (also for a repeated `?app=`) and for a session value read back
at the callback.

## CORS

`cors` middleware is mounted (`src/configs/cors.config.ts`, `src/app.ts`),
answering with `credentials: true` and an origin callback (`isAllowedOrigin`,
`src/utilities/origin.utilities.ts`) that grants exactly `WEB_URL`, `APEX_URL`
and any origin listed in `CORS_ALLOWED_ORIGINS` — never a wildcard, which the
CORS spec forbids alongside `credentials: true` anyway. A request with no
`Origin` header (same-origin, or any non-browser client) is always allowed; CORS
is a browser-only mechanism and there is nothing to enforce against a client
that doesn't send one.

**Accepted consequence, not a vulnerability.** Any origin listed in
`CORS_ALLOWED_ORIGINS` (a second frontend on a sibling subdomain, by design)
can drive a credentialed, `application/json` cross-origin request. The
content-type CSRF gate below still holds — a disallowed origin gets no grant
header, and an HTML form still cannot send `application/json` — but an XSS or
full takeover of that second frontend reaches this API the same way the
primary frontend does. That is the trade that lets a second frontend call the
API at all, and the reason `CORS_ALLOWED_ORIGINS` should list only origins
this deployment trusts with the primary frontend's own level of access.

## Security headers

`helmet` (`src/configs/helmet.config.ts`) is the first middleware mounted in
`src/app.ts` — before `cors`, before the body parsers, before any route — so
every response carries these headers, including a 404, a 415 rejection, an
error response, and a CORS preflight:

- `Content-Security-Policy: default-src 'none';frame-ancestors 'none'` — this
  API serves no HTML, so the policy forbids loading any resource type and
  blocks framing entirely, rather than allow-listing script/style sources
  that don't apply to a JSON API.
- `Cross-Origin-Resource-Policy: same-site`, not helmet's default
  `same-origin`. CORP is a separate check from CORS: it is only consulted for
  a `no-cors` request (an `<img>`/`<script>`-style embed, or anything under
  `Cross-Origin-Embedder-Policy`), never for the credentialed `fetch`/XHR
  calls the frontends make — those are gated by CORS alone. The second
  frontend on a sibling subdomain (`CORS_ALLOWED_ORIGINS`, see "CORS" above)
  is a different origin but the same registrable site, so `same-origin` would
  refuse even a harmless no-cors embed from it. `same-site` allows that while
  still refusing one from any origin outside the registrable domain.
- `Referrer-Policy: no-referrer` — no `Referer` header leaks to anywhere,
  including this API's own other origins.
- `X-Content-Type-Options: nosniff` — stops a browser from MIME-sniffing a
  JSON response body into something it will execute.
- `Cache-Control: no-store` on every response behind `requireAuth`, refusals
  included, and on the two token responses (`POST /auth/login`,
  `POST /auth/refresh`; RFC 6749 §5.1). Without it a browser keeps an
  authenticated body (the staff user directory, a profile, tenants,
  notifications) in its disk cache, and anyone with that browser profile can
  read it back after sign-out with no credential (ASVS 8.2.1). It must be
  `no-store`: `no-cache` and `private` still store the body, and express sends
  an ETag. A route with its own policy keeps it: the SSE stream, behind
  `requireAuth`, sets `no-cache` after it, and the public
  `GET /status/maintenance` is `public, max-age=5`. **Precondition of the risk
  this closes:** the reader needs the same browser profile after sign-out (a
  shared machine, devtools or the cache directory) or a script already running
  on the app origin. No remote attacker gains anything.
- No `Strict-Transport-Security`. HSTS is owned by the TLS-terminating edge
  (the load balancer, ingress or CDN in front), which is the only hop that
  knows the response went out over HTTPS and which hosts `includeSubDomains`
  may safely cover; the clients' `nginx.conf` says the same. helmet's default
  is turned off (`strictTransportSecurity: false`,
  `src/configs/helmet.config.ts`). **Cost of this ruling:** an express served
  straight over TLS with no edge in front sends no HSTS at all until the
  operator adds it there.

`app.disable('x-powered-by')` (`src/app.ts`) stays in place alongside
helmet's own `X-Powered-By` removal — harmless, and explicit about intent.

## No CSRF middleware — reasoning about the shipped design

CSRF relies on a browser automatically attaching ambient credentials (a session
cookie) to a cross-site request. This API's credentials are not purely ambient:
an `Authorization: Bearer <token>` header is never attached automatically by a
browser, so the access token can't be used cross-site without the frontend's own
code choosing to send it. The one credential that _is_ a cookie — the refresh
token — is `sameSite: 'strict'` (or `'lax'` when set by the Google OAuth
callback), and neither lets the browser attach it to a cross-site `POST`, which
every route that reads it is (see "Cookies" above, including the eTLD+1
assumption). The OAuth session cookie (`oauth.sid`, prefixed under
`COOKIE_SECURE`) exists only on `GET /api/v1/auth/google` and its callback, for
five minutes, and carries the OAuth `state` check. If a project relaxes
`sameSite` further, or mounts a browser session on other routes, this conclusion
no longer holds and CSRF protection must be revisited explicitly.

**Same-site is not same-origin.** `SameSite=Strict` withholds the refresh
cookie only from a cross-_site_ request. A page on a sibling subdomain (a
marketing site, docs, user content, a compromised second app) is the same
site, and a body-less `POST` from it needs no preflight. The content-type gate
allows a request with no content type, so without an Origin check such a page
could log the user out (`/auth/logout` revokes the session) or force a refresh
rotation. Neither leaks a token: there is no ACAO for that origin. The two
routes that read the cookie, `POST /auth/refresh` and `POST /auth/logout`,
therefore run `requireAllowedOriginWhenPresent`
(`src/middlewares/origin.middleware.ts`) before their limiters. It answers
**403 `ORIGIN_NOT_ALLOWED`** when an `Origin` header is present and is none of
`WEB_URL`, `APEX_URL` or a `CORS_ALLOWED_ORIGINS` entry, unless the browser
marks the request `Sec-Fetch-Site: same-origin` (a frontend served beside the
API under any host; no page can set a `Sec-` header). A request with no
`Origin` (a non-browser client) passes. A browser without Fetch Metadata
(Safari before 16.4) on an origin that is not configured is refused there, so
a deployment whose frontend origin is none of those three lists it in
`CORS_ALLOWED_ORIGINS`. These two routes do not require `application/json`:
the shipped clients send them with no body and no content type.

### The other CSRF direction: forced login

Everything above reasons about an attacker making a victim's browser act
**with the victim's credentials**. There is a second direction: an attacker
making a victim's browser log in **with the attacker's credentials**.

`app.ts` mounts `express.urlencoded()` globally. Without a gate, an attacker's
page could auto-submit a cross-site form to `POST /api/v1/auth/login` carrying
the attacker's own email and password. A cross-site form POST needs no CORS
permission — the browser sends it and merely hides the response — and
`sameSite: 'strict'` is no defence here, because **it governs when a cookie
is sent, not whether a cross-site response may set one**. The victim's
browser would store the reply's `Set-Cookie`, and the victim would be
silently signed into the attacker's account. Everything they do next — a
document uploaded, a card saved, a search typed — would happen inside an
account the attacker can log into and read at leisure.

`requireJsonContentType` (`src/middlewares/content-type.middleware.ts`),
mounted on the whole auth router, closes it: a request declaring any content
type other than `application/json` is refused with **415**, before the
handler sees the body. An HTML form can only ever submit
`application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
so refusing those removes the form vector by construction; and requiring
`application/json` forces a CORS preflight on any cross-origin script. An
allowed origin gets a grant and proceeds to this gate on its own merits; a
disallowed one gets no grant header and is blocked by the browser before this
middleware runs. Either way, the HTML-form vector sends no preflight at all
and is refused here regardless of CORS.

A content-type gate was chosen over relying on the Origin allow-list alone
because it needs no configuration of its own and holds even for a
same-origin deployment with `CORS_ALLOWED_ORIGINS` unset — the allowlist can
be misconfigured or absent; this gate cannot be. A request declaring **no**
content type is allowed, because an untyped body is inert: neither body
parser parses one, so it never reaches a validator, and `/refresh` and
`/logout` are legitimately called with no body at all. (`/auth/refresh` and
`/auth/logout` add the Origin check above.)

## Design decisions that ARE implemented

Each is written down because "we have no protection here" and "this attack
does not apply to this design" look identical in a code review, and only one
of them is a finding.

### Error logs never carry bound query parameters

A 5xx is logged server-side (`src/middlewares/error.middleware.ts`) so a
masked "Internal server error" is still diagnosable. What gets logged is
redacted first: a failed database query is recorded as its **SQL text**
(parameterised, so it names tables and columns and holds no values), the
driver's `SQLSTATE` code, the parameter count, and the call frames — never
its bound parameters.

The logger also redacts on its own, so a call site can't forget to.
`serializeErrors` (`src/services/logger.service.ts`) walks each logged error
and its `cause` chain, five errors deep. It replaces any error that carries a
query and its parameters with `redactedForLog(error)`. An error logged under
a top-level key such as `{ error }`, including one wrapped as another error's
`cause`, keeps its SQL text and `SQLSTATE` code and loses its parameters.
Other errors serialize as their name, message, stack and `cause`.

This is not a theoretical precaution. `drizzle-orm` builds
`DrizzleQueryError`'s message as `` `Failed query: ${query}\nparams:
${params}` `` (`node_modules/drizzle-orm/errors.js`), so logging the error
object unredacted puts the parameters of the failing statement into the log.
For a failed `insert into users` those parameters are the registrant's
**email address and bcrypt hash**. `BaseRepository` intercepts only `23505`
(unique violation, answered 409); every other failure — an over-long value, a
check violation, a dropped connection mid-statement — propagates intact. The
driver error's own message and `detail` are dropped for the same reason at
one remove: Postgres embeds offending values in some of them (`Key
(lower(email))=(...) already exists.`).

Separately: `email`, `firstName` and `lastName` are capped at exactly the
width of the `users` column each is written to (`MAX_EMAIL_LENGTH`/
`MAX_NAME_LENGTH`, `src/constants/auth.constants.ts` — the same constants
`user.model.ts` declares those columns with). A schema looser than its column
does not just fail; it fails as a **500**, because Postgres's `22001` is not a
unique violation and nothing translates it.

### A failed job keeps no live link

Verification, reset and invitation emails carry their token inside a link in
the job's payload (`verificationUrl`, `resetUrl`, `acceptUrl`). Failed jobs
stay in Redis so an operator can read `failedReason`: 7 days for email, 3 for
notifications. A job fails for the last time when its attempts are used up
or it threw BullMQ's `UnrecoverableError`. The worker then rewrites the job's
stored data, replacing every key ending in `Url` or `Token`, and every
recipient address key (`to`, `cc`, `bcc`, `replyTo`, `reply_to`, `recipient`
or `recipients`, in any letter case, which the `email_messages` row already
keeps), whatever the value's type (a string, a list, an object), at any depth,
with `[redacted]`. It then logs one `error` line, `job failed permanently`,
with the queue, job id and name, user id, attempt count and reason, the
email template when the job names one, and the `errorId` of the failure's
error-tracking report. An earlier attempt logs a `warn` and
keeps the link, because the retry has to send it. So a token sits in Redis
only while a retry is pending, unless the rewrite itself fails, which logs
its own `error` line.

### Secret scanning at two layers

[`gitleaks`](https://github.com/gitleaks/gitleaks) runs as an optional local
pre-commit hook (`.pre-commit-config.yaml`, `.gitleaks.toml`) and as a check
on every pull request (`.github/workflows/gitleaks.yml`), which also re-scans
each push to `main`. That push run starts after the commits have landed, so
it detects a leak but cannot block it. The local hook alone is not a gate —
it is one `git commit --no-verify` away from being skipped — so the pull
request check is the enforcement layer; the pre-commit hook exists to catch a
leak before it is even pushed.

### Dependency audit: a gate with one documented escape hatch

The `test` job in `.github/workflows/ci.yml` runs
`pnpm audit --prod --audit-level moderate`, so any moderate, high or critical
advisory in a production dependency fails CI on every PR. A second step runs
`pnpm audit --audit-level critical` over every dependency, dev tooling
included, with `continue-on-error`: a critical advisory in tooling that never
ships shows on the run without failing it. When a patched version exists but
a parent has not taken it, pin it under `overrides` in `pnpm-workspace.yaml`,
one entry per affected version line, with a comment naming the GHSA; remove
the entry once `pnpm why` shows every parent resolving a patched version
itself. When no fixed version exists, ignore that one advisory by its GHSA ID
under `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`
(`pnpm audit --ignore <GHSA>` writes the entry), with a comment giving the
reason and a date to revisit. Either way, list it in
[CONTRIBUTING.md, "Supply-chain bypasses in `pnpm-workspace.yaml`"](CONTRIBUTING.md#supply-chain-bypasses-in-pnpm-workspaceyaml)
like any other change to that file.

### Domain-leak gate

The "Reject domain leakage" step in `.github/workflows/ci.yml` fails CI when a
term listed in `.github/domain-terms.txt` — a term your project must never
leak — appears in a tracked file. See
[CONTRIBUTING.md](CONTRIBUTING.md) for what a project generated from it
should do with that list.

### No `npx <tool>@latest` in committed agent config

This repository commits no `.mcp.json` and no `.claude/settings.json` that
starts a tool by default, for three reasons:

- **Unpinned execution outside the lockfile.** `npx <pkg>@latest` resolves
  and runs whatever is newest on the npm registry at the moment the tool
  launches — not a version anyone reviewed, and not one pnpm's lockfile or
  `pnpm audit` can see. A compromise of that package or its publishing
  account is code execution on every machine that opens the repo, with no
  review window between publish and execution.
- **Auto-enabling removes the one consent step that would catch it.** A
  `.claude/settings.json` that enables a plugin or server by default means a
  contributor never sees, let alone approves, what just started running.
- **A boilerplate multiplies the exposure.** Every project generated from
  this template inherits the same unpinned, auto-enabled server on day one.

**The rule:** a project that wants an MCP server adds one deliberately, at a
version pinned in the committed config (not `@latest`), and does not
auto-enable it for every contributor by default.
