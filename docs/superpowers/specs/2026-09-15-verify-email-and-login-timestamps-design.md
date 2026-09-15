# Design: writing `email_verified_at` and `last_logged_in_at`

Status: approved in brainstorming, not yet planned.
Amends: `docs/superpowers/plans/2026-09-15-email-and-recovery.md` (B3) Task 5.
Base: `origin/main` @ `384f64c` — B3's shipped tasks (0/1/4/2/3) are already there.
Branch/worktree: `feat/verify-email` in `.worktrees/feat-verify-email`.

## The problem

Two `users` columns exist and are written by nothing:

- `email_verified_at` — reserved by B2, owned by B3 Task 5, which was never built.
- `last_logged_in_at` — `user.model.ts:13` says plainly that no code path updates it.

B3's stopping-point note records the first as an open seam
(`docs/superpowers/plans/README.md:66`). This design closes both.

## A conflict in the request, and how it is resolved

The request as stated was three things: write `email_verified_at` via a
verification link, write `last_logged_in_at` at login, **and** write
`email_verified_at` at login. The first and third cannot both ship.

B3's worst finding (recorded at `2026-09-15-email-and-recovery.md:215-235`,
"Ruling S") is that closing the registration response is not enough, because
register CREATES the account with the caller's password — so register-then-login
reads the whole user base (200 = address was free, 401 = taken) with no timing
analysis and no mailbox access. The fix is that **login must refuse an account
whose `emailVerifiedAt` is null**. A login that refuses unverified accounts can
never be the thing that marks one verified: the caller is rejected before any
write, so a login-time write is dead code. Removing Ruling S to make it live
re-opens the oracle and makes the verification link decorative.

**Resolution: build the link flow and the login timestamp; replace the third
with the thing it is actually for** — not locking out accounts that predate the
gate. Once Ruling S lands, every row with `email_verified_at IS NULL` stops being
able to log in.

Verified against the dev database before choosing: 4 live users, all unverified,
and all four are test residue (`alice@example.com`, `grace@example.com`, two
`probe-i4-*` rows). Nothing there needs preserving, and a fresh clone has zero
rows, so a backfill migration would be a no-op.

**Decision: a documented note in `SECURITY.md`, not a migration.** It must state
that a deployment upgrading with existing users has to backfill
`email_verified_at` (`UPDATE users SET email_verified_at = created_at WHERE
email_verified_at IS NULL`) before deploying the gate, or lock those users out.

## Facts an implementer must not assume

Each of these was read in the source on this branch. Getting any one wrong ships
a defect that tests can easily pass over.

1. **`claimOnce` does NOT check expiry.** `user-token.repository.ts:100`, and its
   own doc comment says so in capitals: "EXPIRY NOT CHECKED — its `expiresAt` is
   still the pre-claim value the caller must validate". A caller that trusts the
   predicate ships a verification token redeemable forever. The expiry check is
   this design's job, on the row `claimOnce` returns.
2. **`hashToken` is not exported.** `token.utilities.ts:107` is module-private, so
   a controller cannot hash a presented raw token to look it up. See the new
   `claimToken` export below.
3. **`issueToken(userId, purpose, ttlMs)`** — `token.utilities.ts:266` — takes
   `Exclude<TokenPurpose, 'refresh'>` and returns `{ raw, userId, purpose,
   expiresAt }`. It is already the correct entry point; nothing about it changes.
4. **`sendMail` takes one argument**, a `MailMessage` discriminated union
   (`mailer.service.ts:128, 343`) of `{ to, templateKey, variables }`. It renders
   internally and never throws for a render failure.
5. **`BaseRepository.update(id, values)` is public** (`base.repository.ts:199`)
   and bumps `updatedAt` via `touched()`. `UserRepository` adds only a public
   `findByEmail`; everything else there is `protected`.
6. **`touched()` writes an `updatedAt` of ``sql`now()` ``**, and `SQL` is not part of the
   insert model's type — `Touched<TValues>` intersects it in specially
   (`base.repository.ts:93`). So a ``sql`now()` `` value cannot be passed through
   the public `update()` without a type error. Timestamps written by this design
   use `new Date()`.
7. **Raw tokens are 32 random bytes, hex** (`token.utilities.ts:42,116`) — opaque,
   never JWTs.
8. **`getDummyHash` is module-private to `auth.controller.ts`** (line 62), not a
   utility. Any second caller needs it moved, not copied — a second dummy hash
   would be a second bcrypt cost to keep in step.
9. **`revokeAllForUser` ignores purpose.** `user-token.repository.ts:138` matches
   `userId` alone, so it takes refresh tokens with it. Anything purpose-scoped
   needs a new method.
10. **Registration's 409 comes from the repository, not the controller.**
   `UserRepository.create` translates the unique violation
   (`auth.controller.ts:194`). Closing the oracle means catching that, not
   adding a pre-check — a pre-check would be a second, driftable copy of the
   decision and racy besides.

## Squatting, and why verification needs the password

An attacker registers `victim@example.com` with a password they chose. The row
now exists, unverified. The real owner later registers the same address, is told
nothing (the response is identical by design), and receives the "someone tried to
register with your address" mail.

The harmful step, in every variant of this, is the same one: **`emailVerifiedAt`
being written at click time on a row whose password the clicker did not set.**
Who registered first does not matter.

- *Newest registrant wins* (overwrite the password on a taken-but-unverified
  address) fails when the victim registered first and has not yet clicked: the
  attacker overwrites the password and a fresh link goes to the victim's inbox,
  so the victim's own click verifies the attacker's credentials.
- *Taken writes nothing* fails too, and through the only door left open to the
  victim. A squatted address is "known and unverified", so
  `resend-verification` mails it a link; the victim clicks, the column is
  written, and the attacker logs in with the password they chose.

Both turn a denial of service into a silent account takeover using the victim's
own click as the final step.

**Decision: `POST /auth/verify-email` takes `{ token, password }`.** The attacker
knows the password but can never produce the click; the mailbox owner can produce
the click but not the attacker's password. Neither can verify, so the outcome is
a lockout that password reset recovers — never a takeover. The taken branch still
writes nothing, which also denies an attacker a way to keep resetting an
unverified victim's password.

Consequences to record in `SECURITY.md`:

- **A wrong password burns the token**, because the row is claimed before the
  comparison runs (see the endpoint contract). This is intended, not a defect:
  one link is one attempt, so a leaked or intercepted link gives an attacker
  exactly one guess. A legitimate typo costs the user a resend.
- A squatted address is unrecoverable until password reset exists.
- **Task 6 must set `emailVerifiedAt` on a successful password reset.** Clicking a
  reset link proves mailbox control, which is the proof verification asks for, and
  it is what makes reset the escape route from a squatted address. Task 6 as
  written does not mention the column.

## Endpoint contracts

Every response goes through `successResponse(response, data, message, status)`,
which emits `{ success, message, statusCode, data }`
(`response.utilities.ts:17-29`).

### `POST /api/v1/auth/register` — contract CHANGES

Today: `201`, `'Registration successful.'`, `data` = the public user.
That is the oracle: a duplicate is `409`, a fresh address `201`.

New, identical on both branches, asserted by direct equality of status and body:

```
202 { success: true,
      message: 'If that address can be registered, a verification email has been sent.',
      statusCode: 202,
      data: null }
```

The response can no longer carry the user, because on the existing-address branch
returning the real row would hand an attacker the victim's id and names — a worse
leak than the oracle being closed. What differs between the branches is only
which email goes out:

- address free → account created, `email_verification` token issued, `sendMail`
  with `EMAIL_VERIFICATION_TEMPLATE_KEY`.
- address taken → no write at all, `sendMail` with
  `REGISTRATION_ATTEMPT_TEMPLATE_KEY` ("someone tried to register with your
  address"). See "Squatting" below for why nothing is overwritten.

**`firstName` needs a fallback, and on the taken branch it must come from the
stored row.** `firstName` is `.optional()` at registration
(`auth.validators.ts:82`) and both templates require it —
`requireEmailVariables` throws when it is missing, and `sendMail` catches that
into a `'failed'` log row (fact 4), so the mail silently never arrives and no
test that only asserts a 202 would notice. Fall back to `'there'`. On the taken
branch the value must be the **stored** user's `firstName`, never the submitted
one: the submitted value is attacker-chosen text being delivered into the
victim's inbox.

**A taken address may have no *visible* row.** The unique index is on
`lower(email)` with no `deleted_at` predicate (`user.model.ts:46`), so
registering a soft-deleted user's address still raises the 409 — but
`findByEmail` excludes soft-deleted rows (`user.repository.ts:45`) and returns
`undefined`. Reading `existing.firstName` there is a null dereference on a path
no happy-path test covers. Pin: taken **and** no visible row → send the
registration-attempt mail with the `'there'` fallback, exactly as for a visible
one. The response is unchanged, as it must be.

**Residual timing, accepted.** Both branches already pay bcrypt — `hashPassword`
runs before `create` (`auth.controller.ts:208-210`) — so the two differ by one
token INSERT on the free branch. That is dominated by ordinary network jitter and
is recorded as accepted rather than closed, which is what the plan asked for.

Both sends respond-first and use `.catch()`, never `void` — Ruling T, at
`2026-09-15-email-and-recovery.md`'s findings section: under Node 24 an unhandled
rejection kills the process, and it would do so *only* on one branch, which is
the enumeration oracle again, escalated into a denial of service.

### `POST /api/v1/auth/verify-email`

Request body: `{ token: string, password: string }` — see "Squatting" above for
why the password is required. **Body, not query string** — a token in a query
string reaches access logs and `Referer` headers. The emailed link points at the
frontend (`WEB_URL/verify-email?token=…`); the frontend POSTs it here. That is
what `WEB_URL` is for (`env.config.ts:76` — currently a reserved placeholder
nothing reads).

- Success: `200`, `'Email verified.'`, `data: null`. Sets `emailVerifiedAt` on the
  token's `userId`.
- Every failure — unknown token, wrong purpose, already consumed, expired, **wrong
  password**, or no such user — returns byte-identical: `400`, `'Invalid or
  expired verification token.'`, `data: null`. Distinguishable failures would be a
  token-state oracle, and a distinguishable wrong-password failure would tell an
  attacker holding a link that the address is squatted.
- **Order: claim first, compare second.** `claimToken` consumes the row, then
  `isPasswordValid(password, user?.passwordHash ?? await getDummyHash())` — the
  dummy hash runs even when the claim failed, so every failure costs the same
  bcrypt time, exactly as `login` already does it (`auth.controller.ts:245`).
- Idempotence: a user already verified presenting a fresh valid token succeeds
  and leaves the original `emailVerifiedAt` unchanged. Mechanism, since fact 6
  rules out a `coalesce` through the typed `update()`: a new
  `markEmailVerified(id)` on `UserRepository` whose predicate carries
  `and email_verified_at is null`. A read-then-write in the controller would also
  work and its race is harmless, but the repository method keeps the decision in
  one place and needs no comment explaining a benign race.
  **`markEmailVerified` returning `undefined` is success, not failure** — it means
  the row was already verified, which is the idempotent case. Only a missing user
  is an error, and that is already covered by the identical 400.
- **Prior verification tokens are revoked** — after a successful verify, and on
  every fresh issue from `resend-verification` — so several live links never
  coexist. Leaving earlier links valid means a token from an older mail still
  works after the user re-requested, which is the state a single-use design
  exists to avoid.

  **Not with `revokeAllForUser`.** That method
  (`user-token.repository.ts:138`) matches on `userId` alone with no purpose
  predicate, so it revokes the user's live **refresh** tokens too — calling it
  here would silently log the user out of every device as a side effect of
  requesting a verification mail. This needs a new purpose-scoped
  `revokeAllForUserAndPurpose(userId, purpose)` alongside it, matching
  `userId AND purpose AND revoked_at IS NULL`, with a test proving a live
  `'refresh'` row survives it.

### `POST /api/v1/auth/resend-verification`

Request body: `{ email: string }`. Always `202`, `'If that address needs
verification, a new link has been sent.'`, `data: null` — identical whether the
address is unknown, known-and-unverified, or known-and-already-verified. Mail is
sent only in the middle case.

### `POST /api/v1/auth/login` — guard CHANGES

`|| !user.emailVerifiedAt` joins the existing combined condition at
`auth.controller.ts:248`, which today reads:

```ts
if (!user || !isPasswordCorrect || !user.active || !user.passwordHash) {
```

It must go in *that* condition, not a separate early return. The controller
already computes `isPasswordCorrect` before the guard (B2's constant-time
handling of a non-existent user), so joining it inherits both the identical `401`
body and the bcrypt cost for free. A separate early return would be a timing
oracle in its own right: a fast 401 for unverified against a slow 401 for a wrong
password.

Accepted, documented cost: a legitimate unverified user is told "Invalid email or
password", which is misleading. This is the standard trade and belongs in
`SECURITY.md` rather than being shipped quietly.

## `last_logged_in_at`

One write in `login`, after the **full** guard passes — including the new
`emailVerifiedAt` clause — and before `successResponse`:

```ts
await userRepository.update(user.id, { lastLoggedInAt: new Date() })
```

- After the guard, not before: a failed login must leave no trace on the row.
- **Before `issueRefreshToken`/`setRefreshTokenCookie`**, not after. If the UPDATE
  fails, the 500 then leaves no session row and no `Set-Cookie` header behind —
  ordering it after issuance would hand the client a cookie for a login the
  caller was told had failed.
- Through `update()`, not a raw query, so `touched()` bumps `updated_at` with it
  and the row does not go stale.
- `new Date()` rather than ``sql`now()` ``, for the typing reason in fact 6 above.
  The app/DB clock difference is immaterial for a display timestamp.
- Awaited rather than fire-and-forget: a failure surfaces as a 500 through
  `next(error)`. One indexed UPDATE on an already-successful login path.
- **`refresh` is not a sign-in and is not touched.** Writing there would make the
  column mean "last token rotation", which is a different fact.

## Rate limiting

Task 7 (the rate-limiting task) is not in scope, but an unlimited
`resend-verification` is a mail-bombing endpoint and every existing route already
carries a `create*RateLimiter()` (`auth.routes.ts:47-50`). Adding limiters here
follows the file's own stated convention rather than inventing one.

`rate-limit.middleware.ts:14-42` already specifies this case: one store prefix
per endpoint, and `resend-verification` specifically needs **two layers**, because
an IP-keyed limiter alone lets a distributed attacker mail-bomb one address, and
an email-keyed limiter alone lets anyone who knows an address deny that user
their own verification mail.

| Limiter | Prefix | Key | Window | Limit |
|---|---|---|---|---|
| `createVerifyEmailRateLimiter` | `rl:verify-email:` | IP | 15 min | 30 |
| `createResendVerificationIpRateLimiter` | `rl:resend-verification-ip:` | IP | 60 min | 5 |
| `createResendVerificationEmailRateLimiter` | `rl:resend-verification-email:` | submitted email | 60 min | 20 |

The **IP** layer is the tight one and the **email** layer the generous one, in
that order deliberately. `rate-limit.middleware.ts:39-42` says why: a tight
per-address budget is itself the attack, because anyone who knows an address can
spend it and deny that user their own verification mail. The address budget
bounds mail-bombing; the IP budget is what actually stops the attacker.

Constants live in `rate-limit.middleware.ts` beside the existing four pairs
(`REGISTER_*`, `LOGIN_*`, `REFRESH_*`, `LOGOUT_*` at lines 151-169), same naming.

## Configuration

One new env var, following the existing TTL pattern in `env.config.ts:108-146`
(duration string, validated `ms()`-parseable, named in its own error message):

- `EMAIL_VERIFICATION_TTL`, default `'24h'`.

`WEB_URL` stops being a placeholder — the verification link is built from it. Its
`.describe()` text, which `pnpm env:example` writes into `.env.example`, must be
updated to say so instead of "PLACEHOLDER — nothing reads it yet".

`APP_NAME` (`env.config.ts:250`) supplies the templates' `appName` variable.

## New and changed code

New:

- `src/controllers/verification.controller.ts` — `verifyEmail`, `resendVerification`.
- `src/validators/verification.validators.ts` — `verifyEmailSchema`, `resendVerificationSchema`.
- **`getDummyHash` must move before it can be reused.** It is a module-private
  IIFE in `auth.controller.ts:62`, and `verification.controller.ts` needs the same
  constant-time behaviour. Move it to `src/utilities/password.utilities.ts`
  (alongside `hashPassword` and `isPasswordValid`, which it already calls) and
  export it, leaving `login` importing it rather than owning it. Its memoisation
  closure and the comment explaining why the cache is not a top-level variable
  move with it unchanged.
- `claimToken(raw, purpose)` exported from `src/utilities/token.utilities.ts` —
  hashes with the module-private `hashToken`, calls `claimOnce`, **and rejects an
  expired row** (fact 1). Keeping hashing private is why this is a utility export
  rather than the controller calling the repository.

Changed:

- `src/controllers/auth.controller.ts` — `register` (identical response, two mail
  branches), `login` (Ruling S guard clause, `lastLoggedInAt` write).
- `src/routes/auth.routes.ts` — two routes, with the limiters above.
- `src/middlewares/rate-limit.middleware.ts` — three limiter factories, three
  constants pairs.
- `src/configs/env.config.ts` — `EMAIL_VERIFICATION_TTL`, `WEB_URL` description.
- `SECURITY.md` — the backfill note, and the "unverified user sees a misleading
  401" trade.

## Testing

The blast radius is measured, not estimated: **19 `registerUser(` call sites**
across `tests/integration/api/auth.test.ts` and
`tests/integration/api/auth-refresh.test.ts`, plus 9 `auth/login` call sites.

Both files' helpers break on the register contract change, and they break
*silently* rather than loudly — each tracks created users for `afterEach` cleanup
by reading the id out of the register response:

- `auth.test.ts:153` — `if (response.status === 201 && body.data)
  createdIds.push(body.data.id)`.
- `auth-refresh.test.ts:82` — `if (registerBody.data)
  createdIds.push(registerBody.data.id)`.

With `data: null` and a `202`, both conditions simply go false: no error, no
failure, and every test leaks its rows into the shared worker database. So the
helper change is not cosmetic and is most of this task's actual work:

1. Register through the real endpoint as now.
2. Look the user up by the email just used, to get the id for cleanup.
3. Mark the user verified — **in the helper, never by weakening the gate** — so
   the existing register→login tests keep testing what they were written to test.
   Mechanism: raw `sql`, the way both files already do their cleanup —
   `` sql`update users set email_verified_at = now() where id = ${id}` ``.

Assertions that fail **loudly** and need rewriting, not just the helpers:

- `auth.test.ts:162` — the `201` plus exact-shape `toEqual` on the returned public
  user. Its "no password field of any kind" check is the point of the test and
  needs a new home, since register no longer returns a user; login's response
  still does.
- `auth.test.ts:246` and `:256` — both assert `409` on a duplicate address. That
  status is exactly what this design removes; they become the identical-response
  test.

Tests to write (red first):

- Registering a **new** address and an **existing** one return equal status and
  equal body, by direct equality.
- The new address receives the verification mail; the existing address receives
  the registration-attempt mail. Asserted via Mailpit.
- `POST /auth/verify-email` with a valid token sets `emailVerifiedAt` and
  consumes the token.
- The same token fails the second time.
- A `password_reset` token is rejected by the verify endpoint.
- An **expired** token fails — the test that pins fact 1. Without it, the missing
  expiry check passes every other test in this list.
- All verify failures return identical status and body — including a **wrong
  password**, which must be indistinguishable from an unknown token.
- A wrong-password attempt **consumes** the token: the same link with the correct
  password afterwards still fails.
- Registering a soft-deleted user's address returns the identical response and
  sends the registration-attempt mail rather than crashing.
- Login is refused for an unverified account, with a response equal to the
  wrong-password response.
- Login writes `lastLoggedInAt`; a **failed** login does not.
- `refresh` does not write `lastLoggedInAt`.
- `resend-verification` returns an identical response for unknown,
  unverified and already-verified addresses, and mails only the middle one.
- Issuing a fresh verification token revokes the user's outstanding
  `email_verification` rows and leaves a live `'refresh'` row untouched.

**Mailpit assertions need a shared helper first.** `findMailpitMessages`,
`assertNoMailpitMessage` and `deleteMailpitMessage` exist but are module-scope
functions private to `tests/integration/services/mailer.service.test.ts:60-95`,
not exported. Extracting them to `tests/helpers/mailpit.ts` is a task in its own
right, not a step inside another one.

## Out of scope

Task 6 (forgot/reset password), Task 7 (the full rate-limiting pass beyond the
three limiters above), Task 8 (documentation pass), and Task 3's open review
findings — `appName` still reaching a Subject header, its escaping pinned by no
test, `requireEmailVariables` under-tested. All remain open and are recorded in
the plan's execution-status section.

`user_tokens` and `email_logs` retention remains unowned by any plan.

## Known consequence outside this repo

`react-boilerplate` calls `POST /auth/register` and `POST /auth/login`
(`src/endpoints/auth.endpoints.ts:14,22`) and its register page consumes the
returned user. The register contract change and the verification gate both break
that flow: the frontend needs a "check your email" state, a `/verify-email` route
that POSTs the token **together with a password field** ("confirm your password
to finish"), and a resend action. That password field is not optional polish —
the endpoint rejects without it. That work belongs to the frontend
repo and is not part of this design, but it must not be discovered at
integration time.
