// tests/integration/utilities/claim-token-mutation.test.ts
//
// Task 5, Step 5: prove claimToken's own expiry check — the one line this
// task exists to add — is load-bearing. `claimOnce` (user-token.repository.ts)
// deliberately does NOT check expiry; its own doc comment says so in
// capitals. `claimToken` (token.utilities.ts) is the only thing standing
// between a merely-expired verification/reset link and one that is
// redeemable forever.
//
// WHY `Date.now`, NOT a repository method. Unlike reuse detection
// (token-reuse-mutation.test.ts, which mutates
// `UserTokenRepository.prototype.revokeAllForSession`), claimToken's check
// —
//
//   if (claimed.expiresAt.getTime() <= Date.now()) return undefined
//
// — is inline in the function itself, not delegated to any application
// class `withMutatedMethod` can reach. There is no repository method whose
// absence would reproduce "the row is returned unconditionally": claimOnce
// already ignores expiry on its own, by design, so mutating it changes
// nothing about THIS check. `Date` is, itself, exactly the "shared,
// already-mutable object" withMutatedMethod's own doc comment asks for —
// just a built-in one rather than one this codebase defines. Pinning
// `Date.now()` to epoch 0 for the lifetime of one `claimToken` call makes
// the comparison's right-hand side smaller than any real, positive
// `expiresAt.getTime()` could ever be, so the check can never fire —
// exactly "return the row unconditionally," the behaviour Task 5's brief
// asks this file to demonstrate.
//
// Blast radius, deliberately kept small: the token is issued, and its
// already-expired `expiresAt` is fixed at insert time, BEFORE the mutation
// window opens — `createTokenRow` computes `expiresAt` from the real
// `Date.now()`, and `claimOnce`'s own revocation timestamps
// (`revokedAt`/`consumedAt`/`updatedAt`) are all written via Postgres's own
// `now()` in the SQL text (see `BaseRepository.touched` and `claimOnce`
// itself), never via this process's `Date.now()`. So the only thing
// reading the faked clock during the mutation window is the one `<=`
// comparison in `claimToken` — nothing else in this file's window depends
// on wall-clock time, and no other test file's assertions do either:
// vitest's `pool: 'forks'` runs one test file at a time per worker
// process, and this mutation lives entirely inside one `await`.
//
// Two tests, matching token-reuse-mutation.test.ts's own pattern:
//
//   1. Always on, both directions in one run: mutate the clock, show an
//      expired token is returned instead of refused, then let the harness
//      restore it and show a FRESH expired token is refused again. This is
//      what `pnpm test` and CI run, and it is always green — a regression
//      test for the harness's integration with this check, not a
//      demonstration of red output.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red
//      under that flag: it reproduces, assertion for assertion, the real
//      "refuses an EXPIRED token" test
//      (tests/integration/utilities/token.utilities.test.ts) against the
//      same mutated clock, so the failure shown is the actual regression
//      test failing — not a hand-written stand-in for it. Skipped by
//      default, so the file is green under `pnpm test`/CI without anyone
//      editing anything:
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/utilities/claim-token-mutation.test.ts   # red
//        pnpm exec vitest run tests/integration/utilities/claim-token-mutation.test.ts                    # green
//
//      No file changes between the two runs — only the environment
//      variable differs — and `git status --porcelain` stays empty
//      throughout.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { claimToken, issueToken } from '@/utilities/token.utilities'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `claim-token-mutation-${randomUUID()}@example.test`
}

describe("mutation-test harness, proven on claimToken's expiry check", () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a disposable user row for a test and track it for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user: User = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it('faking Date.now() lets claimToken return an expired row; restoring it refuses that row again', async () => {
    const userId = await createUser()
    // Already expired the instant it is issued — expiresAt is fixed here,
    // using the REAL clock, before the mutation window opens below.
    const issued = await issueToken(userId, 'email_verification', -1000)

    // MUTATED: Date.now() pinned to epoch 0. claimed.expiresAt.getTime() —
    // a real, positive epoch-ms value in the past — can never be <= 0, so
    // claimToken's expiry check can never fire, and the expired row comes
    // back as if it were live.
    await withMutatedMethod(
      Date,
      'now',
      () => 0,
      async () => {
        const claimed = await claimToken(issued.raw, 'email_verification')
        expect(claimed?.userId).toBe(userId)
      }
    )

    // RESTORED: a fresh expired token proves the check is back, using the
    // exact same sequence of calls. (Re-presenting `issued.raw` here would
    // only prove single-use claiming, which the claimToken describe block
    // in token.utilities.test.ts already covers — a fresh token isolates
    // this assertion to the expiry check alone.)
    const issuedAfterRestore = await issueToken(userId, 'email_verification', -1000)
    expect(await claimToken(issuedAfterRestore.raw, 'email_verification')).toBeUndefined()
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is
  // green.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "refuses an EXPIRED token" test’s own assertion against the mutated clock',
    async () => {
      const userId = await createUser()
      const issued = await issueToken(userId, 'email_verification', -1000)

      await withMutatedMethod(
        Date,
        'now',
        () => 0,
        async () => {
          // The real test asserts this is undefined; under the mutated
          // clock it is the claimed row instead, so this assertion fails.
          expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
        }
      )
    }
  )
})
