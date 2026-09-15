// tests/integration/repositories/user-token-claim-atomicity.test.ts
//
// Proves the ONE property task-1-brief.md calls out as the reason not to
// touch `claimOnce` casually: the check-then-write is a single atomic
// statement, so two concurrent callers presenting the same token hash can
// never both win the claim. This survived the claimForRotation -> claimOnce
// rename and the added `purpose` predicate — this file exists to show that
// with real, concurrent database traffic, not just sequential assertions
// (which cannot observe a TOCTOU race at all: see CLAUDE.md's "Proving a
// security behaviour is real" section).
//
// Two tests, same shape as tests/integration/utilities/token-reuse-mutation.test.ts:
//
//   1. Always on: CONCURRENT_CLAIMS real, truly-parallel `claimOnce` calls
//      (matching the test-mode connection pool's own `max: 2`, so both
//      genuinely run at the database at once rather than queueing behind
//      each other) against ONE row. Exactly one may ever return a defined
//      result — Postgres's own MVCC UPDATE semantics (the second statement
//      blocks on the first's row lock, then re-evaluates its WHERE clause
//      against the now-committed row) is what makes this deterministic,
//      not luck or timing. Always green.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red
//      under that flag: swaps `claimOnce` for a non-atomic "select, sleep,
//      then update by id" implementation — the exact TOCTOU shape
//      claimOnce's single-statement form exists to rule out — and
//      reproduces test 1's own assertion against it. The sleep is what
//      makes the two connections reliably interleave (both complete their
//      SELECT before either commits its UPDATE) instead of racing to a
//      serialised, accidentally-safe outcome.
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/user-token-claim-atomicity.test.ts   # red
//        pnpm exec vitest run tests/integration/repositories/user-token-claim-atomicity.test.ts                    # green
//
//      No file changes between the two runs — only the environment
//      variable differs — and `git status --porcelain` stays empty
//      throughout (tests/helpers/mutate.ts).
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  userTokenModel,
  type TokenPurpose,
  type UserToken,
} from '@/database/models/user-token.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql as pgSql } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

// Matches database.service.ts's own test-mode pool size (`max: 2`) exactly,
// so both claims below are guaranteed genuinely concurrent AT THE DATABASE
// — not merely issued concurrently from Node and then serialised waiting
// for a free connection.
const CONCURRENT_CLAIMS = 2

// How long the mutated, non-atomic implementation sleeps between its SELECT
// and its UPDATE. Long enough that two connections reliably both complete
// their SELECT (and both observe `revoked_at IS NULL`) before either
// commits its UPDATE — the TOCTOU window claimOnce's single statement
// exists to close.
const UNSAFE_CLAIM_DELAY_MS = 50

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `claim-atomicity-${randomUUID()}@example.test`
}

/**
 * A disposable, distinct token hash — stands in for a real SHA-256 digest;
 * this file never needs the hash to correspond to a real raw token.
 * @returns A 64-character hex string, unique to this call.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The exact TOCTOU shape `claimOnce`'s single UPDATE statement exists to
 * rule out: a separate SELECT to check `revokedAt IS NULL`, THEN a separate
 * UPDATE — with a deliberate delay between them so two concurrent callers
 * both pass the check before either writes. Cannot use `this.scope`/
 * `this.touched` (both `protected` on BaseRepository): the WHERE and SET
 * clauses are inlined instead, otherwise matching claimOnce's own real
 * predicate exactly (tokenHash + purpose + revokedAt IS NULL + not
 * soft-deleted).
 * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
 * @param purpose - The purpose the token must have been issued for.
 * @returns The claimed row, or undefined when no live row of that purpose matched at SELECT time.
 */
async function unsafeClaimOnce(
  tokenHash: string,
  purpose: TokenPurpose
): Promise<UserToken | undefined> {
  const [found] = await db
    .select()
    .from(userTokenModel)
    .where(
      and(
        eq(userTokenModel.tokenHash, tokenHash),
        eq(userTokenModel.purpose, purpose),
        isNull(userTokenModel.revokedAt),
        isNull(userTokenModel.deletedAt)
      )
    )
    .limit(1)
  if (!found) return undefined

  await new Promise((resolve) => setTimeout(resolve, UNSAFE_CLAIM_DELAY_MS))

  const [updated] = await db
    .update(userTokenModel)
    .set({ revokedAt: sql`now()`, consumedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(userTokenModel.id, found.id))
    .returning()
  return updated
}

/**
 * Fire `times` concurrent `claimOnce` calls at the same hash/purpose and
 * wait for all of them to settle.
 * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
 * @param purpose - The purpose to claim under.
 * @param times - How many concurrent callers to simulate.
 * @returns One result per caller, in no guaranteed order — undefined for every caller that lost the race.
 */
function claimConcurrently(
  tokenHash: string,
  purpose: TokenPurpose,
  times: number
): Promise<(UserToken | undefined)[]> {
  return Promise.all(
    Array.from({ length: times }, () => userTokenRepository.claimOnce(tokenHash, purpose))
  )
}

describe('claimOnce is atomic under real concurrency', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await pgSql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a disposable user row for a test and track it for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it(`exactly one of ${CONCURRENT_CLAIMS} concurrent claims on the same row succeeds`, async () => {
    const userId = await createUser()
    const tokenHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const results = await claimConcurrently(tokenHash, 'password_reset', CONCURRENT_CLAIMS)
    const claimed = results.filter((row): row is UserToken => row !== undefined)

    // Not "at least one" or "at most one" — the atomicity guarantee is
    // exactly one. asserting the count, not just non-emptiness, is what
    // would catch a regression that let every caller win.
    expect(claimed).toHaveLength(1)

    const finalRow = await userTokenRepository.findByHash(tokenHash)
    // Asserted before the field checks below: `finalRow?.revokedAt` alone
    // passes when `finalRow` is `undefined` too (undefined is not null) —
    // this is what actually proves the row still exists and was found, not
    // just that whatever came back (possibly nothing) lacks a null field.
    expect(finalRow).toBeDefined()
    expect(finalRow?.revokedAt).not.toBeNull()
    expect(finalRow?.consumedAt).not.toBeNull()
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is
  // green.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    `reproduces the real "exactly one of ${CONCURRENT_CLAIMS}" assertion against a non-atomic claimOnce`,
    async () => {
      const userId = await createUser()
      const tokenHash = uniqueHash()
      await userTokenRepository.create({
        userId,
        purpose: 'password_reset',
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await withMutatedMethod(
        UserTokenRepository.prototype,
        'claimOnce',
        unsafeClaimOnce,
        async () => {
          const results = await claimConcurrently(tokenHash, 'password_reset', CONCURRENT_CLAIMS)
          const claimed = results.filter((row): row is UserToken => row !== undefined)

          // The real test's own assertion, reproduced against the mutated,
          // non-atomic implementation — this is what goes red, not a
          // hand-written stand-in for it.
          expect(claimed).toHaveLength(1)
        }
      )
    }
  )
})
