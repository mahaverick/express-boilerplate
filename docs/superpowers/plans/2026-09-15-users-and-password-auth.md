# Users and Password Authentication — Implementation Plan (B2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can register, log in, hold a rotating session, and call an authenticated endpoint — with the security properties that make each of those safe pinned by tests.

**Architecture:** Drizzle models under `src/database/models/`, a thin repository layer over them, stateless JWT access tokens paired with opaque refresh tokens persisted as hashes, and an auth middleware that populates `request.user`. Refresh tokens rotate on every use; a reused token revokes its whole session family. Email verification tokens are _issued and verifiable_ here; **delivery** belongs to plan B3.

**Tech Stack:** Drizzle ORM 0.45 + drizzle-kit 0.31 on Postgres 18, bcrypt 6, jsonwebtoken 9, Zod 4, express-rate-limit 8 with the Redis store, Vitest 5 + supertest.

**Spec:** `docs/superpowers/specs/2026-09-14-modernization-design.md` §4.1 (Authentication), §12 (Standards), §13 (security baseline)

## Global Constraints

Inherited from B1 and non-negotiable. Every task's requirements implicitly include this section.

- Node >=24, pnpm 12.4.1, ESM, TypeScript `~6.0.3` (**not 7** — `typescript-eslint` peers `<6.1.0`).
- `moduleResolution: Bundler`, `paths: {"@/*": ["./src/*"]}`, **extensionless internal imports** (`@/services/x.service`, never `.js`).
- **Zero `eslint-disable` in `src/`.** Satisfy rules; do not suppress them. The only disable in the repo is one documented line in `tests/helpers/setup-global.ts`.
- **No barrel files.** No `index.ts` re-export modules; imports are direct.
- `process.env` only inside `src/configs/env.config.ts` and tests — `no-restricted-properties` enforces it. New configuration goes in `EnvSchema`.
- `pnpm lint` = `eslint . && tsc -p tsconfig.typecheck.json --noEmit`. `pnpm format:check` covers the repo.
- Coverage thresholds **80%** on lines, functions, branches, statements, and `coverage.include` is `src/**/*.ts` — new files count whether or not a test imports them.
- `jsdoc/require-jsdoc` with `publicOnly`: every exported symbol needs a description. **No `@param`/`@returns` type tags** — TypeScript carries them.
- `check-file` naming: `*.controller.ts`, `*.repository.ts`, `*.service.ts`, `*.validators.ts`, `*.middleware.ts`, `*.model.ts`, `*.utilities.ts`, `*.constants.ts`, `*.config.ts`.
- Compose runs on host ports **5433** (Postgres) and **6380** (Redis). Do not change them.
- Error envelope is `errorResponse()` in `src/utilities/response.utilities.ts` — the single definition. Throw `HttpError` from `@/middlewares/error.middleware`; never build an envelope by hand.
- Commit normally; hooks work and no `--no-verify` is needed.

## Interfaces available from B1

- `getEnv(): Env`, `parseEnv()`, `getDatabaseUrl()` — `@/configs/env.config`
- `db`, `sql`, `isDatabaseReachable()`, `closeDatabase()` — `@/services/database.service`
- `getRedis()`, `isRedisReachable()`, `closeRedis()` — `@/services/redis.service`
- `createApp()` — `@/app` (no side effects; supertest imports it)
- `HttpError`, `errorHandler` — `@/middlewares/error.middleware`
- `successResponse()`, `errorResponse()` — `@/utilities/response.utilities`
- `requestId`, `REQUEST_ID_HEADER` — `@/middlewares/request-id.middleware`

---

## Task 1: The migration pipeline, proven end to end

B1 shipped drizzle-kit and a config but **never generated or ran a migration**, and CI has no migration step. Everything in this plan sits on that pipeline, so it gets proven before any feature depends on it.

**Files:**

- Create: `src/database/models/user.model.ts`, `src/database/migrate.ts`, `tests/integration/database/migrate.test.ts`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`, `src/configs/env.config.ts`

**Interfaces:**

- Produces: `userModel` (Drizzle table), `type User = InferSelectModel<typeof userModel>`, `type NewUser = InferInsertModel<typeof userModel>`, and `runMigrations(): Promise<void>`.

- [ ] **Step 1: Write the user model**

Columns, deliberately minimal — every field here must be justified by something this plan builds. `core`'s user table has 22 columns including `userCode`, `department`, `designation`; those are product-specific and are NOT carried over.

```ts
// src/database/models/user.model.ts
//
// The shape a new project starts from. Deliberately small: a field nobody
// reads is a field every derived project inherits and has to decide about.
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { boolean, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'

export const userModel = pgTable(
  'users',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking a
    // row count the way a serial does. Built into Postgres 18 — which is why
    // docker-compose and CI both pin 18.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    email: varchar('email', { length: 320 }).notNull(),
    // Nullable: a federated-identity user (plan B4) has no password.
    passwordHash: varchar('password_hash', { length: 60 }),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    active: boolean('active').notNull().default(true),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoggedInAt: timestamp('last_logged_in_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness. Storing email lowercased at the boundary is
    // not enough on its own — two requests racing can both pass a SELECT check
    // and then both INSERT. The database is the only thing that can decide.
    uniqueIndex('users_email_unique').on(sql`lower(${table.email})`),
  ]
)

/** A user row as read from the database. */
export type User = InferSelectModel<typeof userModel>
/** A user row as written to the database. */
export type NewUser = InferInsertModel<typeof userModel>
```

Import `sql` from `drizzle-orm`.

- [ ] **Step 2: Generate the migration and read what it produced**

```bash
pnpm db:migration:generate
find src/database/migrations -name '*.sql' | head
cat src/database/migrations/0000_*.sql
```

Confirm the SQL contains `uuidv7()` and a `lower(email)` unique index. If drizzle emits something unexpected, fix the model rather than hand-editing the SQL — a hand-edited migration diverges from the schema drizzle will diff against next time.

- [ ] **Step 3: Write the migration runner**

```ts
// src/database/migrate.ts
//
// Run from the production image as `node dist/database/migrate.js`, which is
// why drizzle-kit stays a devDependency — it is a build-time tool and never
// ships. Runs to completion and exits; it is not a server.
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDatabase, db } from '@/services/database.service'

/**
 * Apply every pending migration, then close the pool.
 * @returns Resolves when the database is at the latest migration.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: 'src/database/migrations' })
  await closeDatabase()
}
```

Add an entrypoint guard so importing the module in a test does not run it, mirroring `generate-env-example.ts`'s `process.argv[1] === fileURLToPath(import.meta.url)` pattern.

Scripts:

```json
"db:migration:generate": "drizzle-kit generate",
"db:migrate": "tsx src/database/migrate.ts",
"db:migrate:prod": "node dist/database/migrate.js"
```

- [ ] **Step 4: Write the failing test**

```ts
// tests/integration/database/migrate.test.ts
import { describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'

describe('migrations', () => {
  it('creates the users table', async () => {
    const rows = await sql`
      select column_name from information_schema.columns
      where table_name = 'users'
    `
    const columns = rows.map((r) => r.column_name as string)
    expect(columns).toEqual(expect.arrayContaining(['id', 'email', 'password_hash', 'created_at']))
  })

  it('enforces case-insensitive email uniqueness at the database level', async () => {
    const email = `dup-${Date.now()}@example.test`
    await sql`insert into users (email) values (${email})`
    // The UPPERCASE variant must be rejected by the index, not by app code.
    await expect(sql`insert into users (email) values (${email.toUpperCase()})`).rejects.toThrow()
    await sql`delete from users where lower(email) = lower(${email})`
  })
})
```

- [ ] **Step 5: Make the test suite migrate the database first**

The suite currently assumes an empty database. Extend `tests/helpers/setup-global.ts` — or add a vitest `globalSetup` — to run migrations once before any test file. Without it every integration test in this plan fails on a missing table, and the failure looks like a connection problem.

Run: `docker compose up -d && pnpm test tests/integration/database/migrate.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Add the migration step to CI**

CI currently runs tests against an empty database. The Task 8 review of B1 flagged this as harmless _only because_ the sole integration test issued `select 1`. That stops being true here.

In `.github/workflows/ci.yml`, before the test step:

```yaml
- name: Run migrations
  run: pnpm db:migrate
  env:
    DATABASE_URL: postgres://test:test@localhost:5432/boilerplate_test
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add the user model and prove the migration pipeline

B1 shipped drizzle-kit and a config but never generated or ran a
migration, and CI tested against an empty database. Everything in this
plan sits on that pipeline, so it is proven before any feature uses it.

Email uniqueness is a lower(email) index, not an application check: two
requests racing can both pass a SELECT and then both INSERT, so the
database is the only thing that can decide."
```

---

## Task 2: Password hashing

**Files:**

- Create: `src/utilities/password.utilities.ts`, `src/constants/auth.constants.ts`, `tests/unit/utilities/password.utilities.test.ts`

**Interfaces:**

- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`, `BCRYPT_COST`.

- [ ] **Step 1: Add bcrypt**

```bash
pnpm add bcrypt && pnpm add -D @types/bcrypt
```

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { BCRYPT_COST, hashPassword, verifyPassword } from '@/utilities/password.utilities'

describe('password hashing', () => {
  it('produces a verifiable hash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('salts — the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('uses the configured cost, so a weakened cost fails the build', async () => {
    const hash = await hashPassword('x')
    expect(hash.split('$')[2]).toBe(String(BCRYPT_COST).padStart(2, '0'))
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifyPassword('x', 'not-a-bcrypt-hash')).toBe(false)
  })
})
```

The fourth test is the point: `SECURITY.md` states a cost factor, and a doc that claims a number nothing checks is how the claim quietly becomes false.

- [ ] **Step 3: Run and verify it fails** — `Cannot find module '@/utilities/password.utilities'`.

- [ ] **Step 4: Implement**

`BCRYPT_COST = 12` in `auth.constants.ts` with a comment on the cost/latency trade and a pointer to re-evaluate it as hardware improves. `verifyPassword` catches bcrypt's malformed-hash error and returns `false` — a thrown 500 on a corrupt row is worse than a failed login, and it distinguishes "corrupt hash" from "wrong password" to an attacker.

- [ ] **Step 5: Verify, then update `SECURITY.md`** so the stated cost and the constant agree.

- [ ] **Step 6: Commit**

---

## Task 3: The repository layer

**Files:**

- Create: `src/repositories/base.repository.ts`, `src/repositories/user.repository.ts`, `tests/integration/repositories/user.repository.test.ts`

**Interfaces:**

- Produces: `class UserRepository` with `findById`, `findByEmail`, `create`, `update`, `softDelete`, and a `BaseRepository` other repositories extend.

- [ ] **Step 1: Write the failing tests** — round-trip create/find, `findByEmail` is case-insensitive, soft-deleted rows are excluded by default, `create` rejects a duplicate email with a typed error rather than a raw driver error.

- [ ] **Step 2: Run and verify they fail.**

- [ ] **Step 3: Implement `base.repository.ts`**

Generic over the Drizzle table. It owns: soft-delete filtering, `updatedAt` maintenance, and translating Postgres error `23505` (unique violation) into an `HttpError(409)`. That translation lives here precisely once — every repository inheriting it gets the same behaviour, and no controller has to know a driver error code.

- [ ] **Step 4: Implement `user.repository.ts`**

`findByEmail` must match with `lower(email) = lower($1)` so it agrees with the unique index from Task 1. A mismatch there means a user can register a second account differing only in case and then fail to log into either deterministically.

- [ ] **Step 5: Verify and commit.**

---

## Task 4: JWT access tokens and the refresh-token store

**Files:**

- Create: `src/database/models/user-token.model.ts`, `src/repositories/user-token.repository.ts`, `src/utilities/token.utilities.ts`, tests for each
- Modify: `src/configs/env.config.ts` (token lifetimes)

**Interfaces:**

- Produces: `signAccessToken(user)`, `verifyAccessToken(jwt)`, `issueRefreshToken(userId, sessionId)`, `rotateRefreshToken(raw)`, `revokeSession(sessionId)`, `revokeAllSessions(userId)`.

- [ ] **Step 1: Add dependencies** — `pnpm add jsonwebtoken ms && pnpm add -D @types/jsonwebtoken @types/ms`

- [ ] **Step 2: Add token lifetimes to `EnvSchema`**

`ACCESS_TOKEN_TTL` (default `15m`) and `REFRESH_TOKEN_TTL` (default `30d`), validated as `ms`-parseable strings. Validate them with a refinement that actually calls `ms()` and rejects a value it cannot parse — **this is the exact defect the whole rebuild was justified by**: `ms(process.env.REFRESH_TOKEN_EXPIRY)` threw at import time with the variable unset. Here it fails at boot with a named message, and a test pins that.

- [ ] **Step 3: Write the `user_token` model**

Stores a **hash** of the refresh token, never the token. Columns: `id`, `userId`, `sessionId`, `tokenHash`, `expiresAt`, `revokedAt`, `replacedById`, `createdAt`. `replacedById` is what makes reuse detection possible.

- [ ] **Step 4: Generate and run the migration.**

- [ ] **Step 5: Write the failing tests — these are the security properties**

```ts
it('issues an access token carrying the user id and an expiry', …)
it('rejects a token signed with the wrong secret', …)
it('rejects an expired access token', …)
it('rotates: using a refresh token returns a new one and revokes the old', …)
it('detects reuse: presenting an already-rotated token revokes the whole session family', …)
it('stores only a hash — the raw refresh token never appears in the database', …)
```

The reuse-detection test is the one that matters. A stolen refresh token is only containable if using it after the legitimate client has already rotated it revokes everything descended from it.

- [ ] **Step 6: Implement, verify, commit.**

Refresh tokens are opaque random strings (`crypto.randomBytes(32)`), not JWTs — a JWT refresh token cannot be revoked without a store anyway, and an opaque one cannot leak claims.

---

## Task 5: The auth middleware

**Files:**

- Create: `src/middlewares/auth.middleware.ts`, `tests/unit/middlewares/auth.middleware.test.ts`
- Modify: `src/types/express.d.ts`

**Interfaces:**

- Produces: `requireAuth` middleware populating `request.user: AuthenticatedUser`.

- [ ] **Step 1: Write the failing tests** — missing header → 401; malformed header → 401; valid token → `request.user` populated; expired token → 401 with a distinguishable code so a client knows to refresh rather than re-login; token for a deleted or inactive user → 401 even though the signature is valid.

That last case is why the middleware loads the user rather than trusting claims alone: a stateless token stays valid after an account is disabled unless something checks.

- [ ] **Step 2: Run, verify failure, implement, verify.**

- [ ] **Step 3: Commit.**

---

## Task 6: Register and login

**Files:**

- Create: `src/validators/auth.validators.ts`, `src/controllers/auth.controller.ts`, `src/routes/auth.routes.ts`, `src/routes/index.routes.ts`, `tests/integration/api/auth.test.ts`
- Modify: `src/app.ts` (mount the router)

- [ ] **Step 1: Write the failing integration tests**

```ts
it('registers a user and returns no password field of any kind', …)
it('rejects a weak password with a field-level error', …)
it('rejects a duplicate email with 409, not 500', …)
it('normalises email case on registration', …)
it('logs in with correct credentials and sets a refresh cookie', …)
it('gives the SAME error for an unknown email and a wrong password', …)
it('refuses login for a soft-deleted user', …)
```

The identical-error test prevents user enumeration: differing responses let an attacker harvest which addresses are registered.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement validators, controller, routes; mount at `/api/v1/auth`.**

The refresh token goes in an `httpOnly`, `sameSite`, `secure`-in-production cookie; the access token is returned in the body. Never return `passwordHash` — construct the response from an explicit field list rather than deleting keys from the row, because a `delete` is a thing someone forgets when they add a column.

- [ ] **Step 4: Verify, commit.**

---

## Task 7: Refresh rotation, logout, and login rate limiting

**Files:**

- Create: `src/middlewares/rate-limit.middleware.ts`, `src/configs/rate-limit-store.config.ts`, tests
- Modify: `src/controllers/auth.controller.ts`, `src/routes/auth.routes.ts`

- [ ] **Step 1: Add `express-rate-limit` and `rate-limit-redis`.**

- [ ] **Step 2: Write the store**

Redis-backed, falling back to in-memory when Redis is unavailable, with the fallback logged once rather than per request. Port the reasoning from the reference implementation: limiters are built at module-import time, before the startup sequence connects anything, so the store must latch rather than resolve eagerly.

- [ ] **Step 3: Write the failing tests** — rotation returns a new pair and invalidates the old; logout revokes the session and a subsequent refresh fails; the login limiter returns 429 after N attempts and sets `RateLimit-*` headers; the limiter keys on IP **and** submitted email, so one attacker cannot lock out an unrelated user by guessing their address.

- [ ] **Step 4: Implement, verify, commit.**

---

## Task 8: Profile endpoints

**Files:**

- Create: `src/controllers/profile.controller.ts`, `src/routes/profile.routes.ts`, `src/validators/profile.validators.ts`, tests

- [ ] **Step 1: Write the failing tests** — `GET /api/v1/profile` returns the authenticated user and no password field; 401 without a token; `PATCH` updates permitted fields; `PATCH` **ignores** `email`, `id`, `passwordHash` and `active` even when supplied (mass-assignment protection, asserted explicitly).

- [ ] **Step 2: Implement, verify, commit.**

---

## Task 9: Documentation and the email-verification seam

**Files:**

- Modify: `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `DATABASE.md`, `SECURITY.md`, `CLAUDE.md`

- [ ] **Step 1: Update `SECURITY.md`** — auth now exists. Replace the "Not implemented" rows for authentication and password hashing with what actually ships, keeping every still-true "not implemented" row honest (CSP, CORS, rate limiting beyond login, MFA).

- [ ] **Step 2: Update `STRUCTURE.md`** — `src/controllers/`, `src/repositories/`, `src/validators/`, `src/routes/`, `src/database/models/` now exist with real examples. The final review of B1 singled out this file for describing directories that did not exist; it can now describe ones that do.

- [ ] **Step 3: Update `DATABASE.md`** — the migration workflow with real output, not the previously-documented failing case.

- [ ] **Step 4: Document the B3 seam** — email verification tokens are issued and verifiable here; nothing sends them yet. State that plainly in `ARCHITECTURE.md` rather than leaving a reader to discover it.

- [ ] **Step 5: Run every documented command**, then commit.

---

## Definition of done

- [ ] `pnpm install && pnpm lint && pnpm test:coverage && pnpm build && pnpm format:check` all exit 0 from a clean clone.
- [ ] `docker compose up -d && pnpm db:migrate && pnpm dev` serves registration and login.
- [ ] Coverage at or above 80% on all four metrics.
- [ ] A refresh token, once rotated, cannot be reused — and reusing it revokes the family.
- [ ] No response anywhere contains `passwordHash`, asserted by test.
- [ ] Unknown email and wrong password are indistinguishable to a caller.
- [ ] CI runs migrations before tests.
- [ ] The domain-leak gate still passes.

## Self-review notes

Checked against the spec on 2026-09-15.

**Spec coverage.** Implements §4.1's registration, login, refresh rotation and session handling, plus the §13 password-hashing baseline and the login half of rate limiting. Deferred with their owning plan: email delivery and forgot/reset → B3; Google OAuth and MFA → B4; tenancy and RBAC → B5.

**Deliberate omission.** Email _delivery_ is not here. Verification tokens are issued and verifiable, and Task 9 documents the seam. Mailpit already runs in compose, so B3 has somewhere to send to on day one.

**Type consistency.** `User`/`NewUser` (Task 1) are consumed under those names in Tasks 3, 5, 6 and 8. `signAccessToken`/`verifyAccessToken`/`rotateRefreshToken`/`revokeSession` (Task 4) are the names Tasks 5, 6 and 7 import. `requireAuth` (Task 5) is what Tasks 6 and 8 mount.

**Risk carried from B1.** `src/database/migrations/` was gitignored until the final fix wave. Task 1 Step 2 must confirm the generated migration is actually tracked by git before proceeding — `git status` showing it as ignored is the failure to watch for.
