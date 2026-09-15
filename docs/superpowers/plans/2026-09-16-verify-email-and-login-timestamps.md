# Verify-email and login timestamps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `users.email_verified_at` and `users.last_logged_in_at` written by real code paths — a verification link that requires the account password, and a login timestamp — closing the register-then-login enumeration oracle in the process.

**Architecture:** Registration stops distinguishing a free address from a taken one: both answer an identical `202`, and only the outbound mail differs. A verification token (the `email_verification` purpose the B3 token store already supports) is issued on the free branch and redeemed at `POST /auth/verify-email`, which requires `{ token, password }` so that neither a squatter who knows the password nor a mailbox owner who does not can complete verification alone. `login` then refuses any account whose `emailVerifiedAt` is null, in the same guard that already runs bcrypt, and writes `lastLoggedInAt` once that guard passes.

**Tech Stack:** TypeScript (ESM, `@/` path alias), Express 5, Drizzle ORM on Postgres 18, Zod validators, Vitest (`pnpm test`), nodemailer against a Mailpit container, `express-rate-limit` on a shared Redis store, pnpm 12.4.1.

**Spec:** `docs/superpowers/specs/2026-09-15-verify-email-and-login-timestamps-design.md` — read it before Task 1. This plan argues from it; where the two disagree, the spec wins and the plan is wrong.

**Worktree:** `.worktrees/feat-verify-email`, branch `feat/verify-email`, based on `origin/main` @ `384f64c`.

## Global Constraints

- **Argue, do not comply.** If a step below states something the source contradicts, stop and say so. Seven briefs in the previous run of this project stated facts that were wrong, and every one was caught by an implementer who checked rather than obeyed. That is the single most valuable thing you can do here.
- **Never hand-edit `src/` to prove a test fails.** Use `tests/helpers/mutate.ts`. `CLAUDE.md` documents why: a hand-edited mutation once left a live mass-assignment hole in a tracked file.
- **Enumeration-resistance is asserted by direct equality of status and body**, never "both are 2xx".
- **`claimOnce` does NOT check expiry.** `user-token.repository.ts:100`'s own doc comment says so in capitals. Expiry is the caller's job, on the row it returns.
- **`revokeAllForUser` ignores purpose** (`user-token.repository.ts:138`) — it would take refresh tokens with it. Never call it for verification cleanup.
- **`hashToken` is module-private** (`token.utilities.ts:107`). Controllers cannot hash a presented token; that is why Task 5 exists.
- **`touched()` writes a database-side `updatedAt`, and `SQL` is not in the insert model's type** (`base.repository.ts:93`) — a `sql` value cannot pass through the public `update()`. Timestamps written from a controller use `new Date()`.
- **Mail sends are respond-first and use `.catch()`, never `void`.** Under Node 24 an unhandled rejection kills the process, and it would do so on one branch only — which is the enumeration oracle again, escalated into a denial of service.
- **Every route on `auth.routes.ts` carries a rate limiter with its own store prefix.** That file's header comment states it as a standing rule, not a per-route decision.
- **Gate before every commit:** `pnpm lint && pnpm test && pnpm format:check`. The baseline this branch starts from is 235 passing tests, lint/build/format clean.
- Commit messages: conventional-commit prefix, and end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01X9GsWxpLHaAkfEGJQMv5hB
  ```

## File structure

| File | Responsibility | Task |
|---|---|---|
| `tests/helpers/mailpit.ts` | **New.** Mailpit's HTTP API, shared by every test that asserts on mail | 1 |
| `src/utilities/password.utilities.ts` | Gains `getDummyHash`, moved out of a controller so a second caller can have it | 2 |
| `src/configs/env.config.ts` | Gains `EMAIL_VERIFICATION_TTL`; `WEB_URL` stops being a placeholder | 3 |
| `src/utilities/verification-link.utilities.ts` | **New.** Builds the frontend verification URL from `WEB_URL` | 3 |
| `src/repositories/user.repository.ts` | Gains `markEmailVerified` | 4 |
| `src/repositories/user-token.repository.ts` | Gains `revokeAllForUserAndPurpose` | 4 |
| `src/utilities/token.utilities.ts` | Gains `claimToken` — the expiry-checking claim path | 5 |
| `src/controllers/auth.controller.ts` | `login` writes `lastLoggedInAt` (6) and gains the verified guard (9); `register` becomes oracle-free (8) | 6, 8, 9 |
| `src/validators/verification.validators.ts` | **New.** Bodies for verify and resend | 7, 10 |
| `src/controllers/verification.controller.ts` | **New.** `verifyEmail` (7), `resendVerification` (10) | 7, 10 |
| `src/middlewares/rate-limit.middleware.ts` | Three new limiter factories | 7, 10 |
| `src/routes/auth.routes.ts` | Two new routes | 7, 10 |
| `SECURITY.md` | The squatting trade, the burnt-token rule, the backfill requirement | 11 |

**Sequencing constraint:** Tasks 7, 8, 9 and 10 all modify `auth.routes.ts` and/or `auth.controller.ts`. They are **strictly sequential** and must not be dispatched in parallel. Tasks 1–5 touch disjoint files and could run in parallel, but Task 8 consumes all of them.

---

### Task 1: Extract the Mailpit helpers

Every test from Task 7 onward asserts on mail. The helpers to do that already exist, but they are module-scope functions private to one test file, so nothing else can use them. Test-only task: no file under `src/` changes.

**Files:**
- Create: `tests/helpers/mailpit.ts`
- Modify: `tests/integration/services/mailer.service.test.ts:45-100` (delete the local copies, import instead) and its later `fetch(`${MAILPIT_API}/message/...`)` call at `:498`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `findMailpitMessages(recipient: string): Promise<MailpitMessage[]>`
  - `assertNoMailpitMessage(recipient: string): Promise<void>`
  - `deleteMailpitMessage(id: string): Promise<void>`
  - `getMailpitMessage(id: string): Promise<MailpitMessageDetail>`
  - `drainMailpit(recipient: string): Promise<void>`
  - `interface MailpitMessage { ID: string; To: { Address: string }[]; Subject: string }`
  - `interface MailpitMessageDetail { HTML: string; Text: string }`

- [ ] **Step 1: Create the helper, moving the three existing functions verbatim**

`tests/helpers/mailpit.ts`:

```ts
// tests/helpers/mailpit.ts
//
// Mailpit's own HTTP API, shared by every test that asserts on outbound
// mail. These three functions began as module-scope helpers inside
// mailer.service.test.ts and were moved here unchanged when a second test
// file needed them — the comments below are theirs.
import { expect } from 'vitest'

const MAILPIT_API = 'http://localhost:8025/api/v1'

export interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

export interface MailpitMessageDetail {
  HTML: string
  Text: string
}

/**
 * Poll Mailpit's own HTTP API for messages to one recipient, retrying
 * briefly — a real SMTP delivery is not synchronous with Mailpit's search
 * index becoming queryable.
 * @param recipient - The `To:` address to search for.
 * @returns Every matching message; empty if none arrived within the budget.
 */
export async function findMailpitMessages(recipient: string): Promise<MailpitMessage[]> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    if (body.messages.length > 0) return body.messages
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

/**
 * Confirm no message ever arrives for one recipient. Polls the FULL budget
 * every time — there is no "arrived" signal to short-circuit on — so it is
 * used sparingly.
 * @param recipient - The `To:` address that must never receive anything.
 * @returns Resolves once nothing was found.
 */
export async function assertNoMailpitMessage(recipient: string): Promise<void> {
  const query = `to:${recipient}`
  const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
  const body = (await response.json()) as { messages: MailpitMessage[] }
  expect(body.messages).toHaveLength(0)
}

/**
 * Fetch one message's rendered parts by id.
 * @param id - The Mailpit message id.
 * @returns The message's HTML and plain-text bodies.
 */
export async function getMailpitMessage(id: string): Promise<MailpitMessageDetail> {
  const response = await fetch(`${MAILPIT_API}/message/${id}`)
  return (await response.json()) as MailpitMessageDetail
}

/**
 * Empty one recipient's mailbox, so a later assertion on the same address
 * is not confused by an earlier test's mail. Used by any test that
 * registers twice with one address.
 * @param recipient - The `To:` address to clear.
 */
export async function drainMailpit(recipient: string): Promise<void> {
  for (const message of await findMailpitMessages(recipient)) {
    await deleteMailpitMessage(message.ID)
  }
}

/**
 * Delete one message from Mailpit by id. Best-effort tidiness only, for a
 * mailbox shared across the whole test run — never asserted on, and scoped
 * to one message id so it cannot touch another test's in-flight mail.
 * @param id - The Mailpit message id.
 */
export async function deleteMailpitMessage(id: string): Promise<void> {
  try {
    await fetch(`${MAILPIT_API}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [id] }),
    })
  } catch {
    // Best-effort only — a failed cleanup must never fail a test.
  }
}
```

Read `mailer.service.test.ts:93-100` before writing that final `catch` block: copy its existing body and comment rather than inventing one. If the original swallows differently, the original wins.

- [ ] **Step 2: Delete the local copies and import from the helper**

In `tests/integration/services/mailer.service.test.ts`, delete the local `MAILPIT_API`, `MailpitMessage`, `findMailpitMessages`, `assertNoMailpitMessage` and `deleteMailpitMessage`, and add:

```ts
import {
  assertNoMailpitMessage,
  deleteMailpitMessage,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
```

Use the import path style the file's neighbours already use — check whether the other test files reach helpers via `@/` or a relative path, and match them.

Then replace the inline detail fetch near `:498`:

```ts
const detail = await getMailpitMessage(messageId ?? '')
```

- [ ] **Step 3: Run the full suite — this is the whole proof**

Run: `pnpm test`
Expected: PASS, the same count as the baseline (235). A pure move changes no behaviour, so an unchanged suite is exactly the evidence wanted. If the count *rises or falls*, something else changed and you should stop and say what.

- [ ] **Step 4: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add tests/helpers/mailpit.ts tests/integration/services/mailer.service.test.ts
git commit -m "test: extract the Mailpit helpers so more than one file can assert on mail"
```

---

### Task 2: Move `getDummyHash` into the password utilities

`verification.controller.ts` (Task 7) needs the same constant-time comparison `login` uses. `getDummyHash` is a module-private IIFE in `auth.controller.ts:62`. It must **move**, not be copied: a second dummy hash is a second bcrypt cost to keep in step with `BCRYPT_COST`.

**Files:**
- Modify: `src/utilities/password.utilities.ts` (add the export), `src/controllers/auth.controller.ts:55-68` (delete the IIFE, import instead)
- Test: `tests/unit/utilities/password.utilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getDummyHash(): Promise<string>` exported from `@/utilities/password.utilities`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/utilities/password.utilities.test.ts` (create the `describe` if the file has none for this):

```ts
describe('getDummyHash', () => {
  it('returns a bcrypt hash that no real password validates against', async () => {
    const hash = await getDummyHash()

    expect(hash).toMatch(/^\$2[aby]\$/)
    expect(await isPasswordValid('not-a-real-password-used-only-to-pay-bcrypts-cost', hash)).toBe(
      true
    )
  })

  it('memoises, so the bcrypt cost is paid once per process', async () => {
    const first = await getDummyHash()
    const second = await getDummyHash()

    // Identity, not equality: bcrypt salts every call, so two separate
    // hashings of the same string would NOT be equal. Same string object
    // is the only thing that proves the cache was used.
    expect(second).toBe(first)
  })
})
```

The second test is the one that matters. Without it, deleting the memoisation during the move would leave every login paying a fresh bcrypt, and the first test would still pass.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/unit/utilities/password.utilities.test.ts`
Expected: FAIL — `getDummyHash is not exported` / TypeScript error at the import.

- [ ] **Step 3: Move the IIFE**

Cut `getDummyHash` from `auth.controller.ts:62-68` and paste it into `src/utilities/password.utilities.ts` below `isPasswordValid`, adding `export` and keeping **every line of its comment** — including the paragraph explaining why the cache lives in the closure rather than a top-level variable (it satisfies `unicorn/no-top-level-assignment-in-function` without a disable). Also move the part of `auth.controller.ts`'s header comment that explains *why* a dummy hash exists, or leave a one-line pointer to its new home; do not let the reasoning be orphaned.

```ts
export const getDummyHash: () => Promise<string> = (() => {
  let cached: Promise<string> | undefined
  return (): Promise<string> => {
    cached ??= hashPassword('not-a-real-password-used-only-to-pay-bcrypts-cost')
    return cached
  }
})()
```

In `auth.controller.ts`, add `getDummyHash` to the existing import from `@/utilities/password.utilities`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: PASS — the new two plus every existing login test unchanged. `login`'s behaviour must not move at all; if any existing test needed editing, stop and explain why.

- [ ] **Step 5: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/utilities/password.utilities.ts src/controllers/auth.controller.ts tests/unit/utilities/password.utilities.test.ts
git commit -m "refactor: move getDummyHash to the password utilities for a second caller"
```

---

### Task 3: `EMAIL_VERIFICATION_TTL`, and the link `WEB_URL` finally builds

**Files:**
- Modify: `src/configs/env.config.ts` (the TTL block at `:108-146`, and `WEB_URL` at `:76`)
- Create: `src/utilities/verification-link.utilities.ts`
- Test: `tests/unit/configs/env.config.test.ts`, `tests/unit/utilities/verification-link.utilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EMAIL_VERIFICATION_TTL` on the validated env, a duration string, default `'24h'`
  - `buildVerificationUrl(rawToken: string): string` from `@/utilities/verification-link.utilities`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/configs/env.config.test.ts`, follow the shape the existing `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL` cases already use in that file — read them first and mirror them rather than inventing a new arrangement:

```ts
it('defaults EMAIL_VERIFICATION_TTL to 24h', () => {
  expect(parseEnv(validEnv()).EMAIL_VERIFICATION_TTL).toBe('24h')
})

it('rejects an EMAIL_VERIFICATION_TTL that ms() cannot parse', () => {
  expect(() => parseEnv({ ...validEnv(), EMAIL_VERIFICATION_TTL: 'soon' })).toThrow(
    /EMAIL_VERIFICATION_TTL/
  )
})
```

`parseEnv`/`validEnv` are placeholders for whatever that file actually calls — use its real names.

New file `tests/unit/utilities/verification-link.utilities.test.ts`:

```ts
describe('buildVerificationUrl', () => {
  it('points at the frontend WEB_URL, not the API', () => {
    const url = new URL(buildVerificationUrl('abc123'))

    expect(url.origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(url.pathname).toBe('/verify-email')
    expect(url.searchParams.get('token')).toBe('abc123')
  })

  it('percent-encodes the token rather than concatenating it raw', () => {
    // Tokens are hex today (token.utilities.ts:116), so nothing needs
    // escaping yet. This pins the behaviour anyway: the day the encoding
    // changes, a '+' or '/' in a query string silently decodes to
    // something else, and a verification link stops working for a
    // fraction of users with no error anywhere.
    const url = new URL(buildVerificationUrl('a+b/c=='))

    expect(url.searchParams.get('token')).toBe('a+b/c==')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    // A cloner's .env is as likely to say https://app.example.com/ as
    // https://app.example.com, and //verify-email 404s on most routers.
    expect(buildVerificationUrl('t', 'https://app.example.com/')).toBe(
      'https://app.example.com/verify-email?token=t'
    )
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/unit/configs/env.config.test.ts tests/unit/utilities/verification-link.utilities.test.ts`
Expected: FAIL — no `EMAIL_VERIFICATION_TTL` on the schema, no such module.

- [ ] **Step 3: Add the env var**

In `src/configs/env.config.ts`, beside the other TTLs, copying their `.refine()` shape and their error-message style exactly (each names its own variable, because that message is what a cloner sees at boot):

```ts
  EMAIL_VERIFICATION_TTL: z
    .string()
    .default('24h')
    .refine((value) => Number.isFinite(ms(value as StringValue)), {
      message:
        'EMAIL_VERIFICATION_TTL must be a duration string ms() can parse, e.g. "24h" or "86400000".',
    })
    .describe(
      'How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.'
    ),
```

Read the neighbouring TTLs before writing this — if they validate through a shared helper rather than an inline `.refine()`, use the helper. Do not introduce a second way of doing the same thing.

Then rewrite `WEB_URL`'s `.describe()` at `:76`, which currently says "PLACEHOLDER — nothing reads it yet". It is now read. The text becomes:

```ts
    .describe(
      'Public origin of the frontend. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.'
    ),
```

That text is what `pnpm env:example` writes into `.env.example` as a comment, so leaving it stale is a lie a cloner reads first.

- [ ] **Step 4: Write the link builder**

`src/utilities/verification-link.utilities.ts`:

```ts
// src/utilities/verification-link.utilities.ts
//
// The verification link points at the FRONTEND (WEB_URL), not this API.
// The user clicks it in a mail client, lands on a page, and that page
// POSTs the token — with the account password — to
// POST /api/v1/auth/verify-email. A GET link that verified on its own
// would put the token in a query string this server logs, and would let
// any mail scanner that follows links spend it before the user ever sees
// the message.
import { getEnv } from '@/configs/env.config'

const VERIFICATION_PATH = 'verify-email'

/**
 * Build the verification link mailed to a user.
 * @param rawToken - The raw token from `issueToken`, never its hash.
 * @param webUrl - The frontend origin; defaults to the configured `WEB_URL`.
 * @returns An absolute URL carrying the token as a query parameter.
 */
export function buildVerificationUrl(rawToken: string, webUrl: string = getEnv().WEB_URL): string {
  // `new URL(path, base)` rather than string concatenation: it resolves a
  // trailing slash on the base correctly instead of producing
  // "https://host//verify-email", and it percent-encodes what it is given.
  const url = new URL(VERIFICATION_PATH, webUrl.endsWith('/') ? webUrl : `${webUrl}/`)
  url.searchParams.set('token', rawToken)
  return url.toString()
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/unit/configs/env.config.test.ts tests/unit/utilities/verification-link.utilities.test.ts`
Expected: PASS.

Note the second test asserts `searchParams.get('token')` round-trips `'a+b/c=='`, not that the raw URL string contains it — `URLSearchParams` will encode `+` as `%2B`, which is correct and is the point.

- [ ] **Step 6: Regenerate `.env.example` and gate**

```bash
pnpm env:example
pnpm lint && pnpm test && pnpm format:check
git add src/configs/env.config.ts src/utilities/verification-link.utilities.ts tests/unit .env.example
git commit -m "feat: add EMAIL_VERIFICATION_TTL and build verification links from WEB_URL"
```

Confirm `.env.example` actually changed and is tracked. If `pnpm env:example` writes nothing, say so rather than committing a silently-stale file.

---

### Task 4: The two repository methods

**Files:**
- Modify: `src/repositories/user.repository.ts`, `src/repositories/user-token.repository.ts`
- Test: `tests/integration/repositories/user.repository.test.ts`, `tests/integration/repositories/user-token.repository.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `userRepository.markEmailVerified(id: string): Promise<User | undefined>` — sets `email_verified_at = now()` **only when it is null**; returns `undefined` when the row was already verified or does not exist.
  - `userTokenRepository.revokeAllForUserAndPurpose(userId: string, purpose: TokenPurpose): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/integration/repositories/user.repository.test.ts` — follow the file's existing `createdIds`/`afterEach` cleanup pattern:

```ts
describe('markEmailVerified', () => {
  it('sets email_verified_at and bumps updated_at', async () => {
    const user = await userRepository.create({ email: uniqueEmail(), passwordHash: 'x' })
    createdIds.push(user.id)

    const verified = await userRepository.markEmailVerified(user.id)

    expect(verified?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(verified?.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
  })

  it('leaves an already-verified timestamp untouched and returns undefined', async () => {
    const user = await userRepository.create({ email: uniqueEmail(), passwordHash: 'x' })
    createdIds.push(user.id)
    const first = await userRepository.markEmailVerified(user.id)

    const second = await userRepository.markEmailVerified(user.id)

    // undefined is SUCCESS here, not failure — it is how the caller learns
    // the row was already verified. verification.controller.ts depends on
    // this: a second valid token must answer 200, not 400.
    expect(second).toBeUndefined()
    const reread = await userRepository.findById(user.id)
    expect(reread?.emailVerifiedAt?.getTime()).toBe(first?.emailVerifiedAt?.getTime())
  })

  it('returns undefined for a user that does not exist', async () => {
    expect(await userRepository.markEmailVerified(randomUUID())).toBeUndefined()
  })
})
```

`tests/integration/repositories/user-token.repository.test.ts`:

```ts
describe('revokeAllForUserAndPurpose', () => {
  it('revokes the named purpose and leaves a live refresh token alone', async () => {
    const user = await userRepository.create({ email: uniqueEmail(), passwordHash: 'x' })
    createdIds.push(user.id)
    const refresh = await issueRefreshToken(user.id, randomUUID())
    const verification = await issueToken(user.id, 'email_verification', 60_000)

    await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')

    // This assertion is the entire reason the method exists.
    // revokeAllForUser matches on userId ALONE, so calling it here would
    // silently log the user out of every device as a side effect of them
    // asking for a verification mail.
    expect(await rotateRefreshToken(refresh.raw)).toBeDefined()
    expect(await claimToken(verification.raw, 'email_verification')).toBeUndefined()
  })
})
```

That test consumes `claimToken`, which Task 5 builds. Write it now and expect it red until Task 5 lands, **or** assert the same fact through `userTokenRepository.claimOnce(...)` with the hash — say in your report which you chose and why. Do not leave the assertion out.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/repositories`
Expected: FAIL — neither method exists.

- [ ] **Step 3: Implement `markEmailVerified`**

In `src/repositories/user.repository.ts`, as a public method beside `findByEmail`:

```ts
  /**
   * Mark a user's email verified, once. The `email_verified_at is null`
   * predicate is what makes this idempotent in the database rather than in
   * a caller's read-then-write: a second valid token, or two tabs
   * submitting the same one, must not move a timestamp that already
   * records when the mailbox was first proven.
   * @param id - The user's id.
   * @returns The updated row, or undefined when the user does not exist or was already verified.
   */
  markEmailVerified(id: string): Promise<User | undefined> {
    return this.updateOne(
      this.scope(sql`${userModel.id} = ${id} and ${userModel.emailVerifiedAt} is null`),
      this.touched({ emailVerifiedAt: sql`now()` }) as Parameters<
        UserRepository['updateOne']
      >[1]
    )
  }
```

Before writing that cast, read `base.repository.ts:157-165` (`touched`) and `:247-253` (`updateOne`'s signature). If `touched` already accommodates a `sql` value without a cast — as `claimOnce` at `user-token.repository.ts:100-110` appears to manage — then follow `claimOnce`'s exact pattern and **delete the cast**. A cast that is not needed is worse than none. Report which was true.

`now()` is used here rather than `new Date()` because this runs inside the repository, where `claimOnce` and `touched` already write database-side time; the controller-level rule about `new Date()` (Global Constraints) applies to values passed *through* the public `update()`, which this does not use.

- [ ] **Step 4: Implement `revokeAllForUserAndPurpose`**

In `src/repositories/user-token.repository.ts`, directly below `revokeAllForUser` so the two are read together:

```ts
  /**
   * Revoke every still-live token a user holds FOR ONE PURPOSE. The
   * purpose predicate is the whole point: `revokeAllForUser` above matches
   * on `userId` alone, so using it to clear stale verification links would
   * take the user's live refresh tokens with it and log them out of every
   * device as a side effect of requesting an email.
   * @param userId - The user whose tokens should be revoked.
   * @param purpose - The only purpose to revoke; every other purpose is untouched.
   * @returns Resolves once every matching row is revoked.
   */
  async revokeAllForUserAndPurpose(userId: string, purpose: TokenPurpose): Promise<void> {
    await db
      .update(userTokenModel)
      .set(this.touched({ revokedAt: sql`now()` }))
      .where(
        this.scope(
          sql`${userTokenModel.userId} = ${userId} and ${userTokenModel.purpose} = ${purpose} and ${userTokenModel.revokedAt} is null`
        )
      )
  }
```

Note it sets `revokedAt` alone and **not** `consumedAt` — matching `revokeAllForUser`. `claimOnce`'s comment explains the distinction: `consumedAt` marks a row spent through the normal single-use path, and a link cleared because a newer one was issued was never spent.

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/integration/repositories`
Expected: PASS (except the `claimToken` line, if you chose to leave it red for Task 5).

- [ ] **Step 6: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/repositories tests/integration/repositories
git commit -m "feat: add markEmailVerified and a purpose-scoped token revoke"
```

---

### Task 5: `claimToken` — the claim path that actually checks expiry

`claimOnce` deliberately does not check expiry; its doc comment says so in capitals and a test named `claimOnce claims an expired-but-unrevoked row — expiry is the caller's job, not the predicate's` pins that. `rotateRefreshToken` does its own expiry check. The two non-session purposes need the same, and they cannot do it themselves because `hashToken` is module-private.

**Files:**
- Modify: `src/utilities/token.utilities.ts` (add the export near `issueToken` at `:266`)
- Test: `tests/integration/utilities/token.utilities.test.ts`

**Interfaces:**
- Consumes: `userTokenRepository.claimOnce`, module-private `hashToken`.
- Produces: `claimToken(raw: string, purpose: Exclude<TokenPurpose, 'refresh'>): Promise<UserToken | undefined>` — claims atomically, returns `undefined` for unknown, wrong-purpose, already-claimed **and expired**.

- [ ] **Step 1: Write the failing tests**

```ts
describe('claimToken', () => {
  it('claims a live token once', async () => {
    const issued = await issueToken(userId, 'email_verification', 60_000)

    const claimed = await claimToken(issued.raw, 'email_verification')

    expect(claimed?.userId).toBe(userId)
    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('refuses a token issued for another purpose', async () => {
    const issued = await issueToken(userId, 'password_reset', 60_000)

    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('refuses an EXPIRED token', async () => {
    // THE load-bearing test in this task. claimOnce's WHERE clause has no
    // expiry predicate — it will happily claim this row and return it. If
    // claimToken forwards that row instead of checking expiresAt, every
    // other test above still passes and the product ships a verification
    // link that works forever.
    const issued = await issueToken(userId, 'email_verification', -1000)

    expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
  })

  it('consumes an expired token rather than leaving it claimable', async () => {
    // claimOnce already revoked the row by the time expiry is checked.
    // That is the correct order — one presentation is one attempt — and
    // this pins it so a later "fix" that checks expiry first does not
    // quietly make an expired link retryable.
    const issued = await issueToken(userId, 'email_verification', -1000)
    await claimToken(issued.raw, 'email_verification')

    const row = await userTokenRepository.findByHash(hashOf(issued.raw))
    expect(row?.revokedAt).not.toBeNull()
  })

  it('refuses an unknown token', async () => {
    expect(await claimToken('deadbeef', 'email_verification')).toBeUndefined()
  })
})
```

`issueToken` with a negative `ttlMs` is how you get an already-expired row without waiting or mutating the clock — confirm `createTokenRow` computes `expiresAt` as `now + ttlMs` and therefore accepts it. If it rejects a negative TTL, insert the row through `userTokenRepository` directly instead and say so in your report.

`hashOf` is a stand-in: `hashToken` is not exported, so to read the row back either compute `createHash('sha256').update(raw).digest('hex')` in the test (matching `token.utilities.ts:107` — read it and match it exactly) or query by `userId` and purpose. Pick one; do not export `hashToken` to make a test easier.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/utilities/token.utilities.test.ts`
Expected: FAIL — `claimToken` is not exported.

- [ ] **Step 3: Implement it**

Below `issueToken` in `src/utilities/token.utilities.ts`:

```ts
/**
 * Claim a non-session token — email verification or password reset — once,
 * atomically, and only while it is still live.
 *
 * The expiry check is HERE, not in the predicate, and that is deliberate:
 * `claimOnce` (user-token.repository.ts) matches on hash, purpose and
 * `revoked_at is null` and says in its own comment that expiry is the
 * caller's job. `rotateRefreshToken` below does the same check for
 * `'refresh'`. A caller that skipped it would ship a link that is
 * redeemable forever, and no other test in this file would notice.
 *
 * The row is claimed BEFORE expiry is judged, so presenting an expired
 * token still spends it. One presentation is one attempt; a token that
 * could be retried after failing is not single-use.
 * @param raw - The raw token presented by the caller.
 * @param purpose - The purpose it must have been issued for.
 * @returns The claimed row, or undefined when the token is unknown, of another purpose, already claimed, or expired.
 */
export async function claimToken(
  raw: string,
  purpose: Exclude<TokenPurpose, 'refresh'>
): Promise<UserToken | undefined> {
  const claimed = await userTokenRepository.claimOnce(hashToken(raw), purpose)
  if (!claimed) return undefined
  if (claimed.expiresAt.getTime() <= Date.now()) return undefined
  return claimed
}
```

Check what `UserToken`'s `expiresAt` actually is on this branch — if Drizzle hands back a `Date`, the above is right; if it is a string, compare with `new Date(claimed.expiresAt)`. Read the model rather than assuming.

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/integration/utilities/token.utilities.test.ts`
Expected: PASS, and every pre-existing rotation/reuse test in the file still passing untouched.

- [ ] **Step 5: Prove the expiry check is load-bearing**

Using `tests/helpers/mutate.ts` — **not** by editing `src/`:

- [ ] Replace `claimToken`'s expiry line so it returns the row unconditionally.
- [ ] Run the suite; `refuses an EXPIRED token` must go RED.
- [ ] Restore; it must go GREEN, with `git status` clean throughout.

Record the red output in your report. A test that cannot fail is the defect class this project takes most seriously.

- [ ] **Step 6: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/utilities/token.utilities.ts tests/integration/utilities/token.utilities.test.ts
git commit -m "feat: add claimToken, the claim path that enforces expiry"
```

---

### Task 6: `last_logged_in_at` on a successful login

Independent of the verification work and shippable on its own. Do it before the verification gate lands so it is not hostage to it.

**Files:**
- Modify: `src/controllers/auth.controller.ts` — `login`, around `:245-258`
- Test: `tests/integration/api/auth.test.ts`

**Interfaces:**
- Consumes: `userRepository.update` (`base.repository.ts:199`).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

```ts
it('records lastLoggedInAt on a successful login', async () => {
  const { user, email } = await seedLoginableUser()
  expect(user.lastLoggedInAt).toBeNull()

  await request(app).post('/api/v1/auth/login').send({ email, password: VALID_PASSWORD })

  const reread = await userRepository.findById(user.id)
  expect(reread?.lastLoggedInAt).toBeInstanceOf(Date)
  // updated_at must move with it — the row is not allowed to claim it was
  // last touched before the login that just wrote to it.
  expect(reread?.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
})

it('does not record lastLoggedInAt when the password is wrong', async () => {
  const { user, email } = await seedLoginableUser()

  await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-entirely' })

  const reread = await userRepository.findById(user.id)
  expect(reread?.lastLoggedInAt).toBeNull()
})

it('does not record lastLoggedInAt on refresh — a rotation is not a sign-in', async () => {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  createdIds.push(user?.id ?? '')
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: VALID_PASSWORD })
  const before = await userRepository.findById(user?.id ?? '')

  await request(app)
    .post('/api/v1/auth/refresh')
    // refreshCookiePair is this file's existing helper (auth-refresh.test.ts:65)
    // — the raw Set-Cookie line, replayable verbatim. Do not hand-build one.
    .set('Cookie', refreshCookiePair(login) as string)

  const after = await userRepository.findById(user?.id ?? '')
  expect(after?.lastLoggedInAt?.getTime()).toBe(before?.lastLoggedInAt?.getTime())
})
```

`seedLoginableUser` is local to this task and deliberately does not depend on Task 8's helpers, which do not exist yet:

```ts
async function seedLoginableUser(): Promise<{ user: User; email: string }> {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`seedLoginableUser: no user for ${email}`)
  createdIds.push(user.id)
  // Marked verified even though nothing checks it yet. Task 9 adds the
  // gate, and a helper that marks from the start means these tests carry
  // over unchanged instead of all turning red in a task that is supposed
  // to be two lines of source.
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  const verified = await userRepository.findById(user.id)
  if (!verified) throw new Error(`seedLoginableUser: user vanished for ${email}`)
  return { user: verified, email }
}
```

The third test belongs in `auth-refresh.test.ts`, because `refreshCookiePair` lives there — put it where the helpers are, not where the subject is, and give that file its own copy of `seedLoginableUser` or export one from a shared helper.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/api/auth.test.ts`
Expected: FAIL — `lastLoggedInAt` stays null after a successful login.

- [ ] **Step 3: Implement**

In `login`, between the guard and token issuance:

```ts
    if (!user || !isPasswordCorrect || !user.active || !user.passwordHash) {
      throw new HttpError('Invalid email or password', 401)
    }

    // AFTER the guard, so a failed attempt leaves no trace on the row, and
    // BEFORE tokens are issued, so a failed UPDATE answers 500 without
    // having already set a refresh cookie for a login the caller is being
    // told did not happen.
    //
    // `new Date()` rather than sql`now()`: this goes through the public
    // `update()`, whose value type is the insert model, and SQL is not
    // part of it (base.repository.ts:93). `update()` also bumps
    // `updated_at` via `touched()`, which is why this is not a raw query.
    await userRepository.update(user.id, { lastLoggedInAt: new Date() })

    const sessionId = randomUUID()
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: PASS, all of them.

- [ ] **Step 5: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/controllers/auth.controller.ts tests/integration/api
git commit -m "feat: record lastLoggedInAt on a successful login"
```

---

### Task 7: `POST /auth/verify-email`

The endpoint takes **`{ token, password }`**. Read the spec's "Squatting, and why verification needs the password" section before writing a line of this — the password field is the whole security argument, and an implementer who trims it as redundant reopens a silent account-takeover path.

**Files:**
- Create: `src/validators/verification.validators.ts`, `src/controllers/verification.controller.ts`
- Modify: `src/middlewares/rate-limit.middleware.ts`, `src/routes/auth.routes.ts:47-50`
- Test: `tests/integration/api/verification.test.ts` (new)

**Interfaces:**
- Consumes: `claimToken` (Task 5), `markEmailVerified` (Task 4), `getDummyHash`/`isPasswordValid` (Task 2), `revokeAllForUserAndPurpose` (Task 4).
- Produces: `verifyEmail` (an Express handler), `verifyEmailSchema`, `createVerifyEmailRateLimiter(overrides?: Partial<Options>): RateLimitRequestHandler`.

- [ ] **Step 1: Write the failing tests**

```ts
async function verify(token: string, password: string): Promise<request.Response> {
  return request(app).post('/api/v1/auth/verify-email').send({ token, password })
}

it('verifies with a valid token and the account password', async () => {
  const { user, token } = await seedUnverifiedUser()

  const response = await verify(token, VALID_PASSWORD)

  expect(response.status).toBe(200)
  expect(response.body).toEqual({
    success: true,
    message: 'Email verified.',
    statusCode: 200,
    data: null,
  })
  expect((await userRepository.findById(user.id))?.emailVerifiedAt).toBeInstanceOf(Date)
})

it('answers identically for a wrong password and an unknown token', async () => {
  const { token } = await seedUnverifiedUser()

  const wrongPassword = await verify(token, 'not-the-right-password')
  const unknownToken = await verify('deadbeef', VALID_PASSWORD)

  // Direct equality, not "both are 4xx". A distinguishable wrong-password
  // failure tells an attacker holding a link that the address is squatted.
  expect(wrongPassword.body).toEqual(unknownToken.body)
  expect(wrongPassword.status).toBe(unknownToken.status)
  expect(wrongPassword.status).toBe(400)
})

it('burns the token on a wrong password', async () => {
  const { token } = await seedUnverifiedUser()
  await verify(token, 'not-the-right-password')

  // Intended, and documented in SECURITY.md: one link is one attempt, so a
  // leaked link gives an attacker exactly one guess.
  expect((await verify(token, VALID_PASSWORD)).status).toBe(400)
})

it('refuses the same token twice', async () => {
  const { token } = await seedUnverifiedUser()
  expect((await verify(token, VALID_PASSWORD)).status).toBe(200)

  expect((await verify(token, VALID_PASSWORD)).status).toBe(400)
})

it('refuses a password_reset token', async () => {
  const { user } = await seedUnverifiedUser()
  const reset = await issueToken(user.id, 'password_reset', 60_000)

  expect((await verify(reset.raw, VALID_PASSWORD)).status).toBe(400)
})

it('refuses an expired token', async () => {
  const { user } = await seedUnverifiedUser()
  const expired = await issueToken(user.id, 'email_verification', -1000)

  expect((await verify(expired.raw, VALID_PASSWORD)).status).toBe(400)
})

it('succeeds and leaves the original timestamp when already verified', async () => {
  const { user, token } = await seedUnverifiedUser()
  await verify(token, VALID_PASSWORD)
  const first = await userRepository.findById(user.id)
  const second = await issueToken(user.id, 'email_verification', 60_000)

  const response = await verify(second.raw, VALID_PASSWORD)

  // markEmailVerified returns undefined here — already verified — and that
  // is SUCCESS. Answering 400 would make a double-click an error.
  expect(response.status).toBe(200)
  expect((await userRepository.findById(user.id))?.emailVerifiedAt?.getTime()).toBe(
    first?.emailVerifiedAt?.getTime()
  )
})

it('revokes the user other outstanding verification links', async () => {
  const { user, token } = await seedUnverifiedUser()
  const alsoLive = await issueToken(user.id, 'email_verification', 60_000)

  await verify(token, VALID_PASSWORD)

  expect((await verify(alsoLive.raw, VALID_PASSWORD)).status).toBe(400)
})
```

Every 400 above asserts only the status, because the identical-response test already pins the body. If you prefer to assert the full envelope in each, the failure body is:

```ts
{ success: false, message: 'Invalid or expired verification token.', statusCode: 400, data: null }
```

Check `success` and `data`'s actual values for an error against the terminal error handler (`error.middleware.ts`) before writing that — `successResponse` sets `success: true`, and the error path is a different function whose envelope you must read rather than assume.

`seedUnverifiedUser` is local to this file: create a user through `userRepository.create` with `hashPassword(VALID_PASSWORD)`, push the id onto `createdIds`, call `issueToken(user.id, 'email_verification', 60_000)`, and return `{ user, token: issued.raw }`. Do **not** route it through `POST /auth/register` — that endpoint is still the old contract until Task 8, and this file must not need rewriting when it changes.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/api/verification.test.ts`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Write the validator**

`src/validators/verification.validators.ts`:

```ts
// src/validators/verification.validators.ts
//
// The verify body carries a PASSWORD as well as a token, and it is not
// optional — see the spec's squatting section. Neither field carries the
// registration password policy: this is a comparison against a stored
// hash, exactly like login, and applying a policy here would answer
// differently for a password that was legal when it was set and is not
// now. auth.validators.ts makes the same call for loginSchema.
import { z } from 'zod'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`)
  .pipe(z.email())

/**
 * Verify-email request body: the raw token from the link, plus the
 * account's password.
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required.'),
  password: z.string().min(1, 'Password is required.'),
})

/**
 * The validated shape of a verify-email request body.
 */
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>

/**
 * Resend-verification request body: an address, which may or may not exist.
 */
export const resendVerificationSchema = z.object({ email: emailSchema })

/**
 * The validated shape of a resend-verification request body.
 */
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>
```

`emailSchema` is duplicated from `auth.validators.ts:61-66`. **Do not leave it duplicated** — export it from `auth.validators.ts` and import it here, or move it to a shared validator module. Two copies of an email policy is exactly the drift `MAX_EMAIL_LENGTH`'s own comment warns about. Say which you did.

- [ ] **Step 4: Write the controller**

`src/controllers/verification.controller.ts`:

```ts
// src/controllers/verification.controller.ts
//
// Verification proves TWO things together, and needs both: the caller can
// read the mailbox (they hold the token) and the caller set the password
// (they can produce it). Either alone is insufficient, because an attacker
// can register an address they do not own — so the password is what stops
// a squatted account's real owner from verifying, with their own click,
// an account whose password the attacker chose. The spec's "Squatting"
// section has the full argument; do not remove the password field.
//
// Every failure answers identically. Four distinguishable failures would
// be a token-state oracle, and a distinguishable wrong-password failure
// would tell whoever holds a link that the address is squatted.
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { getDummyHash, isPasswordValid } from '@/utilities/password.utilities'
import { successResponse } from '@/utilities/response.utilities'
import { claimToken } from '@/utilities/token.utilities'
import { parseBody } from '@/validators/auth.validators'
import { verifyEmailSchema } from '@/validators/verification.validators'

// Module-private instances, matching auth.controller.ts:37 and
// token.utilities.ts — this codebase does not export repository
// singletons, each module constructs its own.
const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

const INVALID_TOKEN_MESSAGE = 'Invalid or expired verification token.'

/**
 * Verify an email address with a token from the mailed link and the
 * account's password.
 * @param request - The incoming request, carrying `{ token, password }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function verifyEmail(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(verifyEmailSchema, request.body)

    // Claim FIRST, compare SECOND. One presentation is one attempt, so a
    // wrong password spends the token — see SECURITY.md. The order also
    // means a valid token is never left claimable by an attacker probing
    // passwords against it.
    const claimed = await claimToken(input.token, 'email_verification')
    const user = claimed ? await userRepository.findById(claimed.userId) : undefined

    // The dummy hash runs even when there is no user, so an unknown token
    // costs the same bcrypt time as a real one — the same reasoning, and
    // the same helper, login uses (auth.controller.ts).
    const hashToCompare = user?.passwordHash ?? (await getDummyHash())
    const isPasswordCorrect = await isPasswordValid(input.password, hashToCompare)

    if (!claimed || !user || !user.passwordHash || !isPasswordCorrect) {
      throw new HttpError(INVALID_TOKEN_MESSAGE, 400)
    }

    // undefined means the row was ALREADY verified, which is success: a
    // double-clicked link must not be an error. See markEmailVerified.
    await userRepository.markEmailVerified(user.id)
    // Any other link mailed to this user is now pointless; leaving it live
    // means a token read out of an older mail still works.
    await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')

    successResponse(response, null, 'Email verified.')
  } catch (error) {
    next(error)
  }
}
```

Three import paths here are not where you would guess, which is why they are written out above rather than left to you: `HttpError` lives in `@/middlewares/error.middleware`, **not** a utilities module; `parseBody` is exported from `@/validators/auth.validators`, **not** a validation utility; and repositories are **classes each module instantiates**, not exported singletons (`auth.controller.ts:37`). Still confirm each against the source — if any has moved, the source wins and you should say so.

- [ ] **Step 5: Add the rate limiter**

In `src/middlewares/rate-limit.middleware.ts`, beside the existing constants at `:151-169`:

```ts
const VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const VERIFY_EMAIL_RATE_LIMIT_MAX_ATTEMPTS = 30
```

and a factory following `createRegisterRateLimiter`'s shape exactly:

```ts
/**
 * Build a verify-email rate limiter: `limit` attempts per `windowMs`, keyed
 * on IP. Keyed on IP alone, not IP-and-token: a token is single-use and
 * high-entropy, so there is no per-token budget worth counting — what this
 * bounds is a client working through many tokens. A factory, not a
 * module-scope constant — see this file's header comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createVerifyEmailRateLimiter(
  overrides: Partial<Options> = {}
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS,
    limit: VERIFY_EMAIL_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:verify-email:'),
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}
```

- [ ] **Step 6: Wire the route**

In `src/routes/auth.routes.ts`, after the four existing routes:

```ts
  router.post('/verify-email', createVerifyEmailRateLimiter(), verifyEmail)
```

with `verifyEmail` imported from `@/controllers/verification.controller` and the limiter added to the existing `@/middlewares/rate-limit.middleware` import. The file's header comment names B3's routes as ones that "must follow" the per-route-limiter rule — update that paragraph to say this one has landed rather than leaving it describing the future.

- [ ] **Step 7: Run the tests**

Run: `pnpm test`
Expected: PASS — the new file plus every existing test untouched. Nothing in this task changes `register` or `login`, so any movement there is a bug in this task.

- [ ] **Step 8: Prove the password check is load-bearing**

With `tests/helpers/mutate.ts`: make `isPasswordValid` always return `true`, run the suite, and confirm `answers identically for a wrong password and an unknown token` and `burns the token on a wrong password` go RED. Restore, confirm green, `git status` clean. Record the output.

- [ ] **Step 9: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/validators/verification.validators.ts src/controllers/verification.controller.ts src/middlewares/rate-limit.middleware.ts src/routes/auth.routes.ts src/validators/auth.validators.ts tests/integration/api/verification.test.ts
git commit -m "feat: add POST /auth/verify-email, requiring the account password"
```

---

### Task 8: Registration stops answering two different ways

The biggest task here, and most of it is test work. `register` currently answers `201` with the created user for a free address and `409` for a taken one — that difference *is* the enumeration oracle. Both branches now answer an identical `202` with `data: null`, and only the outbound mail differs.

Because the response no longer carries the user, **both test helpers break silently**: each reads the created id out of the response to track it for cleanup, and with `data: null` those conditions simply go false. No error, no failure — every test quietly leaks rows into the shared worker database. Fix the helpers first.

**Files:**
- Modify: `src/controllers/auth.controller.ts` — `register` at `:200-218`
- Modify: `tests/integration/api/auth.test.ts` (helper at `:146-155`, assertions at `:162`, `:246`, `:256`), `tests/integration/api/auth-refresh.test.ts` (helper at `:76-85`)

**Interfaces:**
- Consumes: `issueToken` + `EMAIL_VERIFICATION_TTL` (Task 3), `buildVerificationUrl` (Task 3), `sendMail`, both templates, `findMailpitMessages` (Task 1).
- Produces: `registerVerifiedUser(overrides?)` and `registerAndLogin(createdIds)` test helpers that Task 9 depends on.

- [ ] **Step 1: Rewrite the test helpers first, against the OLD controller**

In `tests/integration/api/auth.test.ts`, `registerUser` currently ends:

```ts
    if (response.status === 201 && body.data) createdIds.push(body.data.id)
```

Replace the id-from-response read with a lookup by the address just used, which works under both the old and the new contract:

```ts
  async function registerUser(
    overrides: Partial<{ email: string; password: string; firstName: string; lastName: string }> = {}
  ): Promise<{ response: request.Response; body: ApiEnvelope<PublicUserBody>; email: string }> {
    const email = overrides.email ?? uniqueEmail()
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: VALID_PASSWORD, ...overrides })
    const body = envelopeOf<PublicUserBody>(response)
    // Looked up by address rather than read out of the response body.
    // register's response does not carry the user any more (it would be an
    // enumeration oracle), and a helper that reads `body.data.id` does not
    // FAIL when that becomes null — it silently stops tracking the row and
    // leaks it into the shared worker database.
    const created = await userRepository.findByEmail(email)
    if (created) createdIds.push(created.id)
    return { response, body, email }
  }

  /**
   * Register a user and mark them verified, so a test that only needs a
   * usable account does not have to walk the verification flow. Marking is
   * done here, in the helper — NEVER by weakening login's guard.
   * @param overrides - Fields to override on the default registration body.
   * @returns The created user row and the address used.
   */
  async function registerVerifiedUser(
    overrides: Partial<{ email: string; password: string; firstName: string; lastName: string }> = {}
  ): Promise<{ user: User; email: string }> {
    const { email } = await registerUser(overrides)
    const user = await userRepository.findByEmail(email)
    if (!user) throw new Error(`registerVerifiedUser: no user for ${email}`)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    const verified = await userRepository.findById(user.id)
    if (!verified) throw new Error(`registerVerifiedUser: user vanished for ${email}`)
    return { user: verified, email }
  }
```

Raw `sql` is used for the marking because both files already use raw `sql` for cleanup; follow the file, not a new convention.

Apply the same change to `registerAndLogin` in `auth-refresh.test.ts:76-85`, with two differences:

- **Mark the user verified there too.** Task 9 makes that mandatory, and doing it now means Task 9 touches no test helper at all.
- **Return `{ response, email, user }`, not the bare login response.** Task 10 needs the address and the id, and today the helper returns only the response, so a caller has no way to get either. Update its existing call sites to read `.response`.

```ts
async function registerAndLogin(
  createdIds: string[]
): Promise<{ response: request.Response; email: string; user: User }> {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`registerAndLogin: no user for ${email}`)
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`

  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: VALID_PASSWORD })
  return { response, email, user }
}
```

- [ ] **Step 2: Run the suite, still on the old controller**

Run: `pnpm test`
Expected: PASS, 235 + whatever Tasks 1–7 added. The helpers changed, behaviour did not. If anything fails here, the helper rewrite is wrong and fixing it now is far cheaper than after the controller moves.

- [ ] **Step 3: Write the failing tests for the new contract**

```ts
it('answers a free address and a taken one identically', async () => {
  const taken = uniqueEmail()
  await registerUser({ email: taken })

  const free = await registerUser({ email: uniqueEmail() })
  const second = await registerUser({ email: taken })

  // Direct equality of status AND body. "Both are 2xx" would pass while
  // the bodies differed, which is the whole oracle.
  expect(free.response.status).toBe(second.response.status)
  expect(free.response.body).toEqual(second.response.body)
  expect(free.response.status).toBe(202)
  expect(free.response.body).toEqual({
    success: true,
    message: 'If that address can be registered, a verification email has been sent.',
    statusCode: 202,
    data: null,
  })
})

it('mails a verification link to a free address', async () => {
  const email = uniqueEmail()
  await registerUser({ email })

  const messages = await findMailpitMessages(email)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.Subject).toContain('Verify your email')
  const detail = await getMailpitMessage(messages[0]?.ID ?? '')
  expect(detail.Text).toContain('/verify-email?token=')
  await deleteMailpitMessage(messages[0]?.ID ?? '')
})

it('mails a registration-attempt notice to a taken address', async () => {
  const email = uniqueEmail()
  await registerUser({ email })
  await drainMailpit(email)

  await registerUser({ email })

  const messages = await findMailpitMessages(email)
  expect(messages).toHaveLength(1)
  // The notice must NOT carry a verification link: the person registering
  // is not necessarily the person who owns the mailbox, and a link here
  // would let the second registrant verify an account they do not own.
  const detail = await getMailpitMessage(messages[0]?.ID ?? '')
  expect(detail.Text).not.toContain('/verify-email?token=')
})

it('does not leak the stored user when the address is taken', async () => {
  const email = uniqueEmail()
  await registerUser({ email, firstName: 'Real' })

  const second = await registerUser({ email, firstName: 'Attacker' })

  expect(JSON.stringify(second.response.body)).not.toContain('Real')
  expect(second.response.body.data).toBeNull()
})

it('answers identically for a soft-deleted address', async () => {
  // The unique index is on lower(email) with no deleted_at predicate
  // (user.model.ts:46), so create() still raises its 409 — but
  // findByEmail excludes soft-deleted rows and returns undefined, so the
  // taken branch has a 409 and NO row to read a name from. Reading
  // `existing.firstName` there is a null dereference on a path no
  // happy-path test covers.
  const email = uniqueEmail()
  const { email: registered } = await registerUser({ email })
  const user = await userRepository.findByEmail(registered)
  await userRepository.softDelete(user?.id ?? '')

  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: VALID_PASSWORD })

  expect(response.status).toBe(202)
  expect(response.body.data).toBeNull()
})
```

`drainMailpit` comes from `tests/helpers/mailpit.ts` (Task 1) — it lives there rather than in this file because Task 10's tests, in a different file, need it too. Check `userRepository`'s real soft-delete method name (`base.repository.ts` around `:212`) — it may be `softDelete` or `markDeleted`'s public wrapper; use the real one.

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm test tests/integration/api/auth.test.ts`
Expected: FAIL — free returns `201`, taken returns `409`, no mail at all.

- [ ] **Step 5: Rewrite `register`**

```ts
const REGISTER_RESPONSE_MESSAGE =
  'If that address can be registered, a verification email has been sent.'
const MISSING_FIRST_NAME_FALLBACK = 'there'

export async function register(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(registerSchema, request.body)
    const passwordHash = await hashPassword(input.password)

    let created: User | undefined
    try {
      created = await userRepository.create({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
      })
    } catch (error) {
      // 409 is how UserRepository.create reports the unique violation
      // (see its own comment). Anything else is a real failure and must
      // still surface — swallowing every error here would turn a database
      // outage into a cheerful 202.
      if (!(error instanceof HttpError) || error.status !== 409) throw error
    }

    // Respond BEFORE sending, so the two branches do not differ by the
    // latency of an SMTP round trip. The send is deliberately not awaited.
    successResponse(response, null, REGISTER_RESPONSE_MESSAGE, 202)

    if (created) {
      void issueVerificationMail(created).catch((error: unknown) => {
        console.error('Verification mail failed', error)
      })
      return
    }

    // The address is taken. It may STILL have no visible row — the unique
    // index ignores deleted_at while findByEmail does not — so the name
    // falls back rather than being dereferenced.
    void sendRegistrationAttemptMail(input.email).catch((error: unknown) => {
      console.error('Registration-attempt mail failed', error)
    })
  } catch (error) {
    next(error)
  }
}
```

and the two helpers, module-private in the same file:

```ts
/**
 * Issue a verification token for a newly created user and mail them the
 * link.
 * @param user - The user just created.
 */
async function issueVerificationMail(user: User): Promise<void> {
  const issued = await issueToken(
    user.id,
    'email_verification',
    ms(getEnv().EMAIL_VERIFICATION_TTL as StringValue)
  )
  await sendMail({
    to: user.email,
    templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
    variables: {
      firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
      verificationUrl: buildVerificationUrl(issued.raw),
      appName: getEnv().APP_NAME,
    },
  })
}

/**
 * Tell the owner of an already-registered address that someone tried to
 * register it.
 * @param email - The address that was submitted.
 */
async function sendRegistrationAttemptMail(email: string): Promise<void> {
  const existing = await userRepository.findByEmail(email)
  await sendMail({
    to: email,
    templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
    variables: {
      // The STORED name, never the submitted one: the submitted value is
      // attacker-chosen text being delivered into the victim's inbox.
      // `??` covers the soft-deleted case, where the address is taken but
      // no visible row exists to read a name from.
      firstName: existing?.firstName ?? MISSING_FIRST_NAME_FALLBACK,
      appName: getEnv().APP_NAME,
    },
  })
}
```

Three things to verify against source before this compiles:
- `ms` and its `StringValue` type — copy the exact import and cast `token.utilities.ts:89` (`requireDurationMs`) uses. If a shared duration helper exists there, **use it** instead of calling `ms` again here.
- `getEnv().APP_NAME` — `env.config.ts:241` notes nothing in `src/` calls it yet. This is its first caller; check the name is exactly `APP_NAME`.
- Whether `.catch()` on a `void`-ed promise satisfies this repo's lint rules; `void x.catch(...)` and `x.catch(...)` differ under `no-floating-promises`. Match whatever the codebase already does, and keep the `.catch()` either way — Ruling T: an unhandled rejection under Node 24 kills the process, and it would do so on one branch only, which is the oracle again as a denial of service.

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: PASS. The `201`-shape test at `auth.test.ts:162` and the two `409` tests at `:246`/`:256` will fail — they assert exactly what this task removes. Rewrite them:
- `:162`'s "no password field of any kind" assertion is the point of that test and must survive. Move it onto **login's** response, which still returns the user.
- `:246` and `:256` become the identical-response test from Step 3, if they are not already covered by it. Delete them only once you can point at the test that replaced each.

Say in your report, per test, whether it was moved, replaced, or deleted, and why. A test deleted without a named replacement is a regression.

- [ ] **Step 7: Prove the oracle is closed**

With `tests/helpers/mutate.ts`: make `register` answer `201` on the created branch again, confirm `answers a free address and a taken one identically` goes RED, restore, confirm green, `git status` clean.

- [ ] **Step 8: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/controllers/auth.controller.ts tests/integration/api
git commit -m "feat: answer registration identically for free and taken addresses"
```

---

### Task 9: Login refuses an unverified account

Two lines of source, and the reason the previous four tasks were ordered the way they were.

**Files:**
- Modify: `src/controllers/auth.controller.ts` — the guard at `:248`
- Test: `tests/integration/api/auth.test.ts`

**Interfaces:**
- Consumes: `registerUser` / `registerVerifiedUser` (Task 8).
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses an unverified account, identically to a wrong password', async () => {
  const email = uniqueEmail()
  await registerUser({ email })

  const unverified = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: VALID_PASSWORD })
  const wrongPassword = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: (await registerVerifiedUser()).email, password: 'wrong-password-entirely' })

  expect(unverified.status).toBe(wrongPassword.status)
  expect(unverified.body).toEqual(wrongPassword.body)
  expect(unverified.status).toBe(401)
})

it('lets the same account in once it is verified', async () => {
  const email = uniqueEmail()
  await registerUser({ email })
  expect(
    (await request(app).post('/api/v1/auth/login').send({ email, password: VALID_PASSWORD })).status
  ).toBe(401)

  const user = await userRepository.findByEmail(email)
  await sql`update users set email_verified_at = now() where id = ${user?.id}`

  expect(
    (await request(app).post('/api/v1/auth/login').send({ email, password: VALID_PASSWORD })).status
  ).toBe(200)
})
```

The second test is what proves the first is testing the gate rather than a broken login.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/api/auth.test.ts`
Expected: FAIL — the unverified login returns `200`.

- [ ] **Step 3: Add the clause to the existing guard**

```ts
    if (!user || !isPasswordCorrect || !user.active || !user.passwordHash || !user.emailVerifiedAt) {
      throw new HttpError('Invalid email or password', 401)
    }
```

**In that condition, not a separate early return.** `isPasswordCorrect` is computed above it, so joining the existing guard inherits both the identical body and the bcrypt cost. An early return would be a timing oracle in its own right: a fast 401 for unverified against a slow 401 for a wrong password.

Extend the `login` doc comment to say an unverified account is refused the same way a deactivated one is, and why the misleading message is accepted.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS. Every register→login test already goes through a helper that marks the user verified — Task 8's `registerVerifiedUser`/`registerAndLogin`, and Task 6's `seedLoginableUser`, all of which mark from the start precisely so this task breaks nothing. **If a test needs changing here, stop and explain it before changing it** — a test that needs weakening to accommodate this gate may be a test that was asserting something real.

- [ ] **Step 5: Prove the gate is load-bearing**

With `tests/helpers/mutate.ts`, drop the `emailVerifiedAt` clause, confirm both new tests go RED, restore, confirm green.

- [ ] **Step 6: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src/controllers/auth.controller.ts tests/integration/api/auth.test.ts
git commit -m "feat: refuse login for an unverified account, indistinguishably"
```

---

### Task 10: `POST /auth/resend-verification`

**Files:**
- Modify: `src/controllers/verification.controller.ts`, `src/middlewares/rate-limit.middleware.ts`, `src/routes/auth.routes.ts`
- Test: `tests/integration/api/verification.test.ts`

**Interfaces:**
- Consumes: `resendVerificationSchema` (Task 7), `issueToken`, `revokeAllForUserAndPurpose`, `buildVerificationUrl`, `sendMail`.
- Produces: `resendVerification`, `createResendVerificationIpRateLimiter`, `createResendVerificationEmailRateLimiter`.

- [ ] **Step 1: Write the failing tests**

```ts
const RESEND_BODY = {
  success: true,
  message: 'If that address needs verification, a new link has been sent.',
  statusCode: 202,
  data: null,
}

it('answers identically for unknown, unverified and already-verified addresses', async () => {
  const { email: unverified } = await registerUser()
  const { email: verified } = await registerVerifiedUser()

  const responses = await Promise.all(
    [uniqueEmail(), unverified, verified].map((email) =>
      request(app).post('/api/v1/auth/resend-verification').send({ email })
    )
  )

  for (const response of responses) {
    expect(response.status).toBe(202)
    expect(response.body).toEqual(RESEND_BODY)
  }
})

it('mails only the unverified address', async () => {
  const unknown = uniqueEmail()
  const { email: unverified } = await registerUser()
  const { email: verified } = await registerVerifiedUser()
  await drainMailpit(unverified)
  await drainMailpit(verified)

  for (const email of [unknown, unverified, verified]) {
    await request(app).post('/api/v1/auth/resend-verification').send({ email })
  }

  expect(await findMailpitMessages(unverified)).toHaveLength(1)
  await assertNoMailpitMessage(unknown)
  await assertNoMailpitMessage(verified)
})

it('invalidates the previous link when a new one is sent', async () => {
  const { email } = await registerUser()
  const user = await userRepository.findByEmail(email)
  const first = await issueToken(user?.id ?? '', 'email_verification', 60_000)

  await request(app).post('/api/v1/auth/resend-verification').send({ email })

  // Two live links at once means a token read out of an older mail still
  // works after the user has re-requested — the state single-use exists to
  // prevent.
  const response = await request(app)
    .post('/api/v1/auth/verify-email')
    .send({ token: first.raw, password: VALID_PASSWORD })
  expect(response.status).toBe(400)
})

it('leaves a live refresh token alone when it clears old links', async () => {
  // The regression this guards is not hypothetical: revokeAllForUser
  // matches on userId alone, so reaching for it here would log the user
  // out of every device as a side effect of asking for an email.
  const { response: login, email, user } = await registerAndLogin(createdIds)
  await sql`update users set email_verified_at = null where id = ${user.id}`

  await request(app).post('/api/v1/auth/resend-verification').send({ email })

  const refreshed = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', refreshCookiePair(login) as string)
  expect(refreshed.status).toBe(200)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/integration/api/verification.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement the handler**

Append to `src/controllers/verification.controller.ts`:

```ts
const RESEND_RESPONSE_MESSAGE = 'If that address needs verification, a new link has been sent.'

/**
 * Send a fresh verification link, if and only if the address belongs to an
 * existing, unverified account.
 *
 * The response is identical in all three cases — unknown address, known
 * and unverified, known and already verified. Anything else makes this a
 * cheaper enumeration oracle than register, since it needs no password.
 * @param request - The incoming request, carrying `{ email }`.
 * @param response - The response.
 * @param next - Forwards a rejection to the terminal error handler.
 */
export async function resendVerification(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = parseBody(resendVerificationSchema, request.body)
    const user = await userRepository.findByEmail(input.email)

    // Respond first: an SMTP round trip on one branch only is a timing
    // oracle, and this endpoint has no bcrypt cost to hide behind.
    successResponse(response, null, RESEND_RESPONSE_MESSAGE, 202)

    if (!user || user.emailVerifiedAt) return

    void resendVerificationMail(user).catch((error: unknown) => {
      console.error('Resend verification mail failed', error)
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Revoke the user's outstanding verification links and mail a new one.
 * @param user - The unverified user who asked for another link.
 */
async function resendVerificationMail(user: User): Promise<void> {
  // Purpose-scoped: revokeAllForUser would take the user's live REFRESH
  // tokens with it and log them out everywhere.
  await userTokenRepository.revokeAllForUserAndPurpose(user.id, 'email_verification')
  const issued = await issueToken(
    user.id,
    'email_verification',
    ms(getEnv().EMAIL_VERIFICATION_TTL as StringValue)
  )
  await sendMail({
    to: user.email,
    templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
    variables: {
      firstName: user.firstName ?? 'there',
      verificationUrl: buildVerificationUrl(issued.raw),
      appName: getEnv().APP_NAME,
    },
  })
}
```

`issueVerificationMail` in `auth.controller.ts` (Task 8) and `resendVerificationMail` here now differ only by the revoke. **Extract the shared body** — `sendVerificationMail(user: User): Promise<void>` in a module both can import, with the revoke staying at the resend call site — rather than leaving two copies of a template call and a TTL lookup to drift. The `'there'` fallback must be one constant, not two literals.

- [ ] **Step 4: Add the two limiters**

Constants beside the others:

```ts
const RESEND_VERIFICATION_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const RESEND_VERIFICATION_IP_RATE_LIMIT_MAX_ATTEMPTS = 5
const RESEND_VERIFICATION_EMAIL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const RESEND_VERIFICATION_EMAIL_RATE_LIMIT_MAX_ATTEMPTS = 20
```

Two factories, `createResendVerificationIpRateLimiter` (prefix `rl:resend-verification-ip:`, default IP keying) and `createResendVerificationEmailRateLimiter` (prefix `rl:resend-verification-email:`, `keyGenerator` built on the existing `submittedEmail` at `:189`), each copying `createRegisterRateLimiter`'s shape.

Document the asymmetry where the constants live, because it looks backwards until you read the reason:

```ts
// The IP budget is TIGHT and the per-address budget GENEROUS, which is the
// opposite of the obvious arrangement. A tight per-address budget is
// itself the attack: anyone who knows an address can spend it and deny
// that user their own verification mail. The address budget bounds
// mail-bombing one victim; the IP budget is what actually stops the
// attacker. See this file's header comment, which states the rule for
// exactly this pair of endpoints.
```

A dedicated `keyGenerator` for the email-keyed limiter must still be IP-independent — key on the submitted address alone, not the composite `loginRateLimitKey` builds, or the per-address budget is per-address-per-IP and bounds nothing.

- [ ] **Step 5: Wire the route with both limiters**

```ts
  router.post(
    '/resend-verification',
    createResendVerificationIpRateLimiter(),
    createResendVerificationEmailRateLimiter(),
    resendVerification
  )
```

Two limiters in series, not a composite key — each bounds its own threat, and either firing alone must be enough.

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add src tests
git commit -m "feat: add POST /auth/resend-verification behind two rate limiters"
```

---

### Task 11: Write down what was traded away

The findings below are worth more than the code: the previous run of this project lost most of its security reasoning because it lived only in a gitignored scratch directory.

**Files:**
- Modify: `SECURITY.md`, `ARCHITECTURE.md` (the "B3 seam"), `docs/superpowers/plans/README.md`, `docs/superpowers/plans/2026-09-15-email-and-recovery.md`

- [ ] **Step 1: `SECURITY.md` — five entries**

- [ ] **Unverified login is answered "Invalid email or password."** Misleading on purpose: a distinguishable message is an enumeration oracle. State the trade, since it generates support tickets.
- [ ] **Verification requires the password, and a wrong one burns the token.** One link is one attempt, so a leaked link gives an attacker exactly one guess; a legitimate typo costs a resend. Include the squatting scenario both halves of it defend against.
- [ ] **Upgrading with existing users requires a backfill.** Verbatim, because whoever needs it will be mid-incident:
  ```sql
  UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
  ```
  Run it **before** deploying the gate, or every existing user is locked out.
- [ ] **A squatted address is unrecoverable until password reset exists.** Name it as an open gap, not a footnote.
- [ ] **Register's residual timing difference is accepted.** Both branches pay bcrypt (`hashPassword` runs before `create`), leaving one token INSERT, which jitter dominates.

- [ ] **Step 2: `ARCHITECTURE.md` — the "B3 seam" is no longer a seam**

Rewrite it to describe what exists. Leaving it saying "nothing writes this column" is the same class of stale claim this project has repeatedly had to correct.

- [ ] **Step 3: Leave Task 6 a note it currently lacks**

In `docs/superpowers/plans/2026-09-15-email-and-recovery.md`, in Task 6's own text: **a successful password reset must also set `emailVerifiedAt`.** Clicking a reset link proves mailbox control, which is the proof verification asks for, and it is the only escape route from a squatted address. Task 6 as written does not mention the column.

Update `docs/superpowers/plans/README.md`'s B3 row: tasks 5 and 7 are now partly done (verification and its limiters), 6 and 8 are not.

- [ ] **Step 4: Gate and commit**

```bash
pnpm lint && pnpm test && pnpm format:check
git add SECURITY.md ARCHITECTURE.md docs
git commit -m "docs: record the verification trades, the backfill, and Task 6's missing note"
```

---

## What this plan does not do

Out of scope, and recorded so it is not mistaken for an oversight:

- **Task 6 of B3** — forgot/reset password. It is the recovery route for a squatted address, so it is the natural next plan.
- **Task 8 of B3** — the full documentation pass.
- **Task 3's open review findings** — `appName` still reaching a Subject header, its escaping pinned by no test, `requireEmailVariables` under-tested.
- **Retention** for `user_tokens` and `email_logs`. Still owned by no plan; `email_logs` stores real addresses append-only and forever, by design.
- **`react-boilerplate`.** Its register/login flow breaks: register no longer returns a user, login refuses unverified accounts, and the new `/verify-email` page needs a **password field** as well as the token — the endpoint rejects without it. Separate repo, separate plan, but it must not be discovered at integration time.
