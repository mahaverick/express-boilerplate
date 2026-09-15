# Email Delivery and Account Recovery — Implementation Plan (B3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can verify their email address and recover a forgotten password — without either flow telling an attacker which addresses are registered, and without becoming a way to send mail to strangers.

**Architecture:** B2's `user_tokens` table is generalised into a one-shot token store rather than a second table being added: it already has a high-entropy opaque value, SHA-256 at rest, a hash-keyed lookup, expiry, revocation, and an atomic single-claim primitive. Email goes out through nodemailer to Mailpit locally, with every send recorded so "did it send?" is answerable.

**Tech Stack:** nodemailer 10, Mailpit (already in compose), Drizzle 0.45 on Postgres 18, Zod 4, Vitest 5 + supertest.

**Spec:** `docs/superpowers/specs/2026-09-14-modernization-design.md` §4.1, §4.4, §12, §13

## Global Constraints

- Node >=24, pnpm 12.4.1, ESM, TypeScript `~6.0.3` (**not 7**).
- `moduleResolution: Bundler`, **extensionless internal imports**. **Zero `eslint-disable` in `src/`.** No barrel files.
- `process.env` only in `src/configs/env.config.ts`; `no-restricted-properties` enforces it.
- Coverage **80%** on all four metrics, `coverage.include` is `src/**/*.ts`.
- `jsdoc/require-jsdoc` publicOnly, **no `@param`/`@returns` type tags**.
- `check-file` naming. Compose on host ports **5433**/**6380**.
- Throw `HttpError(message, status, code?)`; never build an envelope by hand.
- **Tests touching Postgres, Redis or SMTP go in `tests/integration/`.** `.husky/pre-commit` excludes only that path; a Docker-dependent test under `tests/unit/` makes the hook fail whenever the stack is down, and a hook that fails gets disabled permanently.
- **Mutation proofs run through a test-only harness, not by editing `src/`.** See Task 0.

## Interfaces from B1/B2

`getEnv()` · `db`, `sql` · `createApp()` · `HttpError`, `errorHandler` · `successResponse`, `errorResponse` · `UserRepository` (`findByEmail` is case-insensitive and excludes soft-deleted) · `hashPassword`, `isPasswordValid`, `BCRYPT_COST` · `signAccessToken`, `issueRefreshToken`, `rotateRefreshToken`, `revokeSession`, `revokeAllSessions`, `revokeRefreshToken` · `requireAuth` · `createXRateLimiter` factory · `parseBody` (surfaces `fieldErrors` and `formErrors`)

---

## Task 0: A mutation-test harness, so proofs stop editing production source

Every red/green proof in B1 and B2 worked by temporarily breaking `src/`. It found more defects than anything else — six inert gates, a cost test that could not fail, an unguarded primary key. It also fired **four** CRITICAL/HIGH security alerts on transient states, and once put a live mass-assignment hole in a tracked file while a crashed agent's work was being rescued by `git add -A`.

**Files:** Create `tests/helpers/mutate.ts`, `tests/unit/helpers/mutate.test.ts`

- [ ] **Step 1: Write the failing test** for a helper that swaps a module's export for the duration of one test and restores it afterwards, even if the test throws.
- [ ] **Step 2: Implement it** using `vi.doMock`/`vi.resetModules` or an injected-dependency seam — whichever suits this codebase's import style. It must never write to a file in `src/`.
- [ ] **Step 3: Prove it proves.** Use it to disable one existing security behaviour (reuse detection is the obvious candidate) and show the corresponding test goes red, then green on restore — without any file in `src/` changing on disk at any point. `git status` must stay clean throughout.
- [ ] **Step 4: Document it in `CLAUDE.md`** as the required method, and say why: hand-edited mutations put a live vulnerability in a shared worktree.
- [ ] **Step 5: Commit.**

---

## Task 1: Generalise the token store

**Files:** Modify `src/database/models/user-token.model.ts`, `src/repositories/user-token.repository.ts`, `src/utilities/token.utilities.ts`; new migration; update affected tests.

**Interfaces produced:** `TokenPurpose` (`'refresh' | 'email_verification' | 'password_reset'`), `claimOnce(tokenHash, purpose)`, `issueToken(userId, purpose, ttl)`.

- [ ] **Step 1: Read `claimForRotation` before changing anything.** It is `UPDATE ... SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING *` — already a generic atomic single-claim. The only rotation-specific thing about it is its name. Understand why the atomicity matters (a read-check-write lets two concurrent requests with the same token both succeed) before you touch it.
- [ ] **Step 2: Write the failing tests** — a token issued for one purpose cannot be claimed as another; claiming twice returns undefined the second time; an expired token cannot be claimed.

  The cross-purpose test is the one that matters. Without it, a password-reset token could be spent as an email verification, or worse.

- [ ] **Step 3: Migrate.** Add `purpose` (not null) and `consumedAt`; make `sessionId` and `sessionStartedAt` nullable — they are meaningless for a verification token. Backfill existing rows to `'refresh'`. Confirm the new `.sql` is tracked by git.
- [ ] **Step 4: Rename `claimForRotation` to `claimOnce` and add a `purpose` predicate to its WHERE clause.** Rotation becomes one caller among three. Keep the atomicity comment — it is the reason the function exists.
- [ ] **Step 5: Verify every B2 test still passes.** 235 of them. Rotation, reuse detection and the session cap must be untouched in behaviour. If any test needs changing, say why in the report — a test that needs rewriting to accommodate a refactor is sometimes a test that was asserting the implementation rather than the behaviour, and sometimes a real regression.
- [ ] **Step 6: Commit.**

---

## Task 2: Mail transport

**Files:** Create `src/services/mailer.service.ts`, `src/configs/mailer.config.ts`, tests. Modify `src/configs/env.config.ts`.

- [ ] **Step 1: Add nodemailer** (`pnpm add nodemailer`, `pnpm add -D @types/nodemailer`).
- [ ] **Step 2: Add SMTP configuration to `EnvSchema`** — host, port, optional user/pass, a `MAIL_FROM` address. Default to Mailpit's `localhost:1025`. Optional credentials matter: Mailpit needs none, real providers do.
- [ ] **Step 3: Write the failing test** — a send reaches Mailpit and is retrievable through its HTTP API on 8025. That is an integration test against the real container, not a mock.
- [ ] **Step 4: Implement the transport.** One transporter per process, created lazily. Decide what happens when SMTP is unreachable — a thrown error fails the request that triggered it, which for a _verification_ email means registration fails because mail is down. Argue your choice; there is a real trade between "the user never learns their account exists" and "registration is coupled to SMTP uptime".
- [ ] **Step 5: Verify and commit.**

---

## Task 3: Templates and rendering

**Files:** Create `src/templates/email/*`, `src/utilities/email-template.utilities.ts`, tests.

- [ ] **Step 1: Write the failing tests** — a rendered template contains the interpolated value; **an interpolated value containing HTML is escaped**; a missing variable fails loudly rather than rendering `undefined` into a user-facing email.
- [ ] **Step 2: Implement rendering.** No template engine dependency — this is three emails. Plain-text **and** HTML parts for every message; a text-only client must still be able to act on it.
- [ ] **Step 3: Write the three templates** — verify address, password reset, and "someone tried to register with your address" (Task 5 explains why that third one exists).

  **No token may appear in a subject line.** Subjects are logged by mail servers far more readily than bodies.

- [ ] **Step 4: Verify and commit.**

---

## Task 4: The delivery log

**Files:** Create `src/database/models/email-log.model.ts`, `src/repositories/email-log.repository.ts`, migration, tests.

- [ ] **Step 1: Write the failing tests** — a successful send records a row; a failed send records the failure; **the row never contains the token or the rendered body**. Assert that by querying the table for the raw token and finding nothing, the same way B2 proved refresh tokens are hashed at rest.
- [ ] **Step 2: Implement.** Record recipient, template key, status, provider message id, error, timestamps. This is what makes "did the email send?" answerable at 2am without adding a token to a log.
- [ ] **Step 3: Verify and commit.**

---

## Task 5: Email verification, and closing the registration oracle

**Files:** Create `src/controllers/verification.controller.ts`, `src/validators/verification.validators.ts`; modify `src/controllers/auth.controller.ts`, `src/routes/auth.routes.ts`.

B2 left registration as a bounded-but-open enumeration oracle: a duplicate address returns 409, a fresh one 201. This task closes it, and the mechanism is why the third template exists.

- [ ] **Step 1: Write the failing tests.**
  - Registering a **new** address returns the same status and body as registering an **existing** one — asserted by direct equality, the way B2 asserts it for login.
  - The new address receives a verification email; the existing address receives a "someone tried to register with your address" email instead. Assert both via Mailpit.
  - `POST /auth/verify-email` with a valid token sets `emailVerifiedAt` and consumes the token.
  - The same token used twice fails the second time.
  - A `password_reset` token is rejected by the verify endpoint.
  - An expired token fails.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.** Registration always responds identically; what differs is which email goes out. State plainly in `SECURITY.md` that this closes the oracle B2 could only bound, and note the residual timing difference if one exists.
- [ ] **Step 4: Add `POST /auth/resend-verification`** — identical response whether or not the address exists or is already verified.
- [ ] **Step 5: Verify and commit.**

---

## Task 6: Forgot and reset password

**Files:** Create `src/controllers/recovery.controller.ts`, `src/validators/recovery.validators.ts`, `src/routes/recovery.routes.ts`; modify `src/routes/index.routes.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `POST /auth/forgot-password` returns an **identical** response for a registered and an unregistered address.
  - A registered address receives a reset email; an unregistered one receives **nothing** — and no error is raised.
  - `POST /auth/reset-password` with a valid token sets the new password and **consumes** the token.
  - The same token fails the second time.
  - An `email_verification` token is rejected by the reset endpoint.
  - **A successful reset revokes every existing session** — the user's other refresh tokens stop working. This is the property that matters: a password reset that leaves an attacker's session alive has achieved nothing.
  - The new password must satisfy the same policy registration enforces.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.** Reset tokens get a **short** TTL — an hour, not a day — and it goes in `EnvSchema` so it is visible and changeable.
- [ ] **Step 4: Verify and commit.**

---

## Task 7: Rate limiting the new endpoints

**Files:** Modify `src/middlewares/rate-limit.middleware.ts`, the new routes.

Three of the four new endpoints are simultaneously enumeration oracles **and** outbound-email amplifiers. An unthrottled `forgot-password` lets anyone send mail to any address, repeatedly, from your domain — which is both an abuse vector and a fast way to get your sending reputation destroyed.

- [ ] **Step 1: Write the failing tests** — each of `forgot-password`, `resend-verification`, `verify-email` and `reset-password` returns 429 after its limit; each uses **its own store prefix** so one exhausted bucket does not affect another; and a 429 does not reveal whether the address exists.
- [ ] **Step 2: Implement** using B2's `createXRateLimiter` factory. Key the email-sending endpoints on **both** IP and submitted address, for the reason B2 established: address alone hands anyone a denial-of-service against a known victim, IP alone is bypassed by a distributed attacker.
- [ ] **Step 3: Consider a per-address send ceiling** independent of the rate limiter — "at most N verification emails per address per day" — and say whether you implemented it or why not.
- [ ] **Step 4: Verify and commit.**

---

## Task 8: Documentation

**Files:** Modify `SECURITY.md`, `ARCHITECTURE.md`, `README.md`, `DATABASE.md`, `CLAUDE.md`.

- [ ] **Step 1: `SECURITY.md`** — the registration oracle is now **closed**, not bounded; say what closed it. Document reset-token TTL and single-use, session revocation on reset, and the per-address send ceiling if one exists. **Read the actual constants; do not restate the plan.** A test already asserts this file's bcrypt cost against the code — extend that pattern to any new number you document.
- [ ] **Step 2: `ARCHITECTURE.md`** — B2's stated "B3 seam" is now filled. Remove the note rather than leaving a reader to wonder whether it still applies.
- [ ] **Step 3: `README.md`** — the quickstart covers verifying an address and resetting a password, including where to read the mail (Mailpit at `http://localhost:8025`). **Run every command before committing it.**
- [ ] **Step 4: `CLAUDE.md`** — gotchas only: the token store is one table with a `purpose` discriminator; mutation proofs go through the harness, never by editing `src/`.
- [ ] **Step 5: Verify every documented command, then commit.**

---

## Definition of done

- [ ] `pnpm install && pnpm lint && pnpm test:coverage && pnpm build && pnpm format:check` all exit 0 from a clean clone.
- [ ] Registration is indistinguishable for a new and an existing address.
- [ ] `forgot-password` is indistinguishable for a registered and an unregistered address.
- [ ] Every token is single-use and purpose-bound; a token of the wrong purpose is rejected.
- [ ] A password reset revokes every existing session.
- [ ] No token appears in any log, any email subject, or the `email_log` table.
- [ ] Every new endpoint is rate limited with its own store prefix.
- [ ] All 235 of B2's tests still pass.

## Self-review notes

Checked against the spec on 2026-09-15.

**Spec coverage.** Implements §4.1's email verification and forgot/reset, §4.4's consent-adjacent delivery record, and the §13 baseline for the new endpoints. Deferred: Google OAuth and MFA → B4; tenancy → B5.

**A correction this plan inherits.** B2's self-review claimed email-verification tokens were "issued and verifiable" there. They were not — only the `email_verified_at` column existed. B3 owns the whole flow, and Task 1 is where the store that should have held those tokens gets built properly.

**Type consistency.** `TokenPurpose`, `claimOnce` and `issueToken` (Task 1) are the names Tasks 5 and 6 consume. `sendMail` (Task 2) is what Tasks 5 and 6 call. `emailLogRepository` (Task 4) is what Task 2's transport writes through.

**The riskiest task is 1.** It changes a table and a function that B2's 235 tests depend on, including the security-critical rotation path. It is first precisely so everything after it is built on the settled shape — and its Step 5 exists to catch a regression disguised as a refactor.
