/**
 * @file Proves `claimToken`'s (session.service.ts) own expiry check is
 * load-bearing: `claimOnce` (user-token.repository.ts) deliberately does not
 * check expiry itself, so this check is the only thing standing between a
 * merely-expired verification/reset link and one that is redeemable forever.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { claimToken, issueToken } from '@/services/session.service'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()

/**
 * Returns an address no other test row shares, for the user a test creates.
 */
function uniqueEmail(): string {
  return `claim-token-mutation-${randomUUID()}@example.test`
}

/**
 * The mutation pins `Date.now`, not a repository method. Unlike reuse
 * detection (`token-reuse-mutation.test.ts`, which mutates
 * `UserTokenRepository.prototype.revokeAllForSession`), `claimToken`'s check
 * is inline in the function:
 *
 * ```
 * if (claimed.expiresAt.getTime() <= Date.now()) return undefined
 * ```
 *
 * No application class carries it for `withMutatedMethod` to reach, and no
 * repository method's absence would reproduce "the row is returned
 * unconditionally": `claimOnce` already ignores expiry by design, so mutating
 * it changes nothing about this check. `Date` is the shared, already-mutable
 * object `withMutatedMethod` asks for, a built-in one. Pinning `Date.now()` to
 * epoch 0 for one `claimToken` call makes the comparison's right-hand side
 * smaller than any real, positive `expiresAt.getTime()`, so the check never
 * fires.
 *
 * The blast radius is small. The token is issued, and its already-expired
 * `expiresAt` fixed, before the mutation window opens: `createTokenRow`
 * computes `expiresAt` from the real `Date.now()`, and `claimOnce` writes its
 * `revokedAt`, `consumedAt` and `updatedAt` through Postgres's `now()` in the
 * SQL text (see `BaseRepository.touched`), never this process's `Date.now()`.
 * So the one `<=` comparison in `claimToken` is the only reader of the faked
 * clock in the window. The mutation lives inside one `await`, and vitest's
 * `pool: 'forks'` runs one test file at a time per worker process, so no
 * other file's assertions see it.
 *
 * Two tests, matching `token-reuse-mutation.test.ts`:
 *
 * 1. Always on, both directions in one run: mutate the clock and show an
 *    expired token is returned instead of refused, then let the harness
 *    restore it and show a fresh expired token is refused again. This is what
 *    `pnpm test` and CI run. It is always green, a regression test for the
 *    harness's integration with this check, not a demonstration of red output.
 *
 * 2. `it.runIf(process.env.MUTATION_PROOF === '1')`, deliberately red under
 *    that flag: it reproduces, assertion for assertion, the real "refuses an
 *    EXPIRED token" test (`tests/integration/services/session.service.test.ts`)
 *    against the same mutated clock, so the failure shown is the actual
 *    regression test failing, not a hand-written stand-in. It is skipped by
 *    default, so the file is green under `pnpm test` and CI without anyone
 *    editing anything:
 *
 *    ```
 *    MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/claim-token-mutation.test.ts   # red
 *    pnpm exec vitest run tests/integration/services/claim-token-mutation.test.ts                    # green
 *    ```
 *
 *    No file changes between the two runs, only the environment variable, so
 *    `git status --porcelain` stays empty throughout.
 */
describe("mutation-test harness, proven on claimToken's expiry check", () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates the user that owns the tokens a test issues, deleted in `afterEach`.
   */
  async function createUser(): Promise<string> {
    const user: User = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it('faking Date.now() lets claimToken return an expired row; restoring it refuses that row again', async () => {
    const userId = await createUser()
    /**
     * Already expired the instant it is issued: `expiresAt` is fixed here,
     * from the real clock, before the mutation window opens below.
     */
    const issued = await issueToken(userId, 'email_verification', -1000)

    /**
     * Mutated: `Date.now()` is pinned to epoch 0. `claimed.expiresAt.getTime()`,
     * a real, positive epoch-ms value in the past, can never be `<= 0`, so
     * `claimToken`'s expiry check never fires and the expired row comes back
     * as if it were live.
     */
    await withMutatedMethod(
      Date,
      'now',
      () => 0,
      async () => {
        const claimed = await claimToken(issued.raw, 'email_verification')
        expect(claimed?.userId).toBe(userId)
      }
    )

    /**
     * Restored: a fresh expired token proves the check is back, using the
     * same sequence of calls. Re-presenting `issued.raw` would only prove
     * single-use claiming, which the `claimToken` describe block in
     * `session.service.test.ts` already covers; a fresh token isolates this
     * assertion to the expiry check.
     */
    const issuedAfterRestore = await issueToken(userId, 'email_verification', -1000)
    expect(await claimToken(issuedAfterRestore.raw, 'email_verification')).toBeUndefined()
  })

  /**
   * Deliberately red when run with `MUTATION_PROOF=1`, as the describe
   * block's comment explains. Left unset, this test is skipped and the file is
   * green.
   */
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
          /**
           * The real test asserts this is undefined; under the mutated
           * clock it is the claimed row instead, so this assertion fails.
           */
          expect(await claimToken(issued.raw, 'email_verification')).toBeUndefined()
        }
      )
    }
  )
})
