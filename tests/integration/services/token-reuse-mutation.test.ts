/**
 * @file Proves the mutation-test harness (`tests/helpers/mutate.ts`) on a
 * REAL security behaviour, against the real per-worker Postgres database:
 * reuse detection (`rotateRefreshToken`, `session.service.ts`).
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { issueRefreshToken, rotateRefreshToken } from '@/services/session.service'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()

/**
 * An address unique to each call, so users created by different tests never collide.
 */
function uniqueEmail(): string {
  return `mutation-proof-${randomUUID()}@example.test`
}

/**
 * Age a user's consumed tokens past REFRESH_REUSE_GRACE_MS, so a replay counts as reuse rather than a concurrent refresh.
 */
async function ageConsumedTokensPastGrace(userId: string): Promise<void> {
  await sql`
    update user_tokens set consumed_at = consumed_at - interval '11 seconds'
    where user_id = ${userId} and consumed_at is not null
  `
}

/**
 * Presenting an already-rotated refresh token must revoke every token in its session family,
 * which contains a stolen token as soon as its holder uses it. The one call that does so is
 * `UserTokenRepository.prototype.revokeAllForSession` (see `rotateRefreshToken`'s header).
 * `revokeRefreshToken` (logout) makes the same call, so mutating it disables both "reuse not
 * detected" and "logout not revoking" at once.
 *
 * Two tests:
 *
 * 1. Always on, both directions in one run: mutate the guard, show the family survives an
 *    attack it should have killed, then let the harness restore it and show a fresh family
 *    does not survive the same attack. `pnpm test` and CI run this, and it is always green:
 *    it is a regression test for the harness on real security code, not a demonstration of
 *    red output.
 *
 * 2. `it.runIf(process.env.MUTATION_PROOF === '1')`, deliberately red under that flag: it
 *    reproduces, assertion for assertion, the "detects reuse" test in
 *    `tests/integration/services/session.service.test.ts` against the same mutated guard, so
 *    the failure shown is that regression test failing. It is skipped by default, so the file
 *    is green under `pnpm test` and CI without editing anything:
 *
 *    ```
 *    MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/token-reuse-mutation.test.ts   # red
 *    pnpm exec vitest run tests/integration/services/token-reuse-mutation.test.ts                    # green
 *    ```
 *
 *    No file changes between the two runs, only the environment variable, so
 *    `git status --porcelain` stays empty throughout.
 */
describe('mutation-test harness, proven on reuse detection', () => {
  /**
   * Ids of the users this file creates. `afterEach` deletes them, which cascades
   * (`ON DELETE CASCADE` on `user_tokens.user_id`) to their token rows, so no mutation proof
   * leaves anything in the per-worker database.
   */
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a user for a test and track it for the `afterEach` cleanup; resolves with its id.
   */
  async function createUser(): Promise<string> {
    const user: User = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it('disabling revokeAllForSession lets a reused token survive; restoring it brings reuse detection back', async () => {
    const userId = await createUser()

    /**
     * Mutated: `revokeAllForSession` is a no-op. `rotateRefreshToken` still rejects the reused
     * token itself, because `claimOnce` finds it already revoked and the throw is unconditional,
     * so the tell is whether the family survives. In the product it must not.
     */
    const mutatedSessionId = randomUUID()
    const issued = await issueRefreshToken(userId, mutatedSessionId)
    const rotated = await rotateRefreshToken(issued.raw)
    await ageConsumedTokensPastGrace(userId)

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'revokeAllForSession',
      () => Promise.resolve(0),
      async () => {
        await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

        // With the guard disabled the legitimate client's token is still usable: the attack that should have ended the session did nothing.
        const stillRotatable = await rotateRefreshToken(rotated.raw)
        expect(stillRotatable.sessionId).toBe(mutatedSessionId)
      }
    )

    // Restored: a fresh family, with the same sequence of calls, shows the guard is back.
    const restoredSessionId = randomUUID()
    const issuedAfterRestore = await issueRefreshToken(userId, restoredSessionId)
    const rotatedAfterRestore = await rotateRefreshToken(issuedAfterRestore.raw)
    await ageConsumedTokensPastGrace(userId)

    await expect(rotateRefreshToken(issuedAfterRestore.raw)).rejects.toMatchObject({
      statusCode: 401,
    })
    // The family did not survive this time: the legitimate client's token is dead too.
    await expect(rotateRefreshToken(rotatedAfterRestore.raw)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  /**
   * Deliberately red under `MUTATION_PROOF=1` (see the comment on the describe above); with it
   * unset this test is skipped and the file is green.
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "detects reuse" test’s own assertions against the mutated guard',
    async () => {
      const userId = await createUser()
      const sessionId = randomUUID()

      await withMutatedMethod(
        UserTokenRepository.prototype,
        'revokeAllForSession',
        () => Promise.resolve(0),
        async () => {
          const issued = await issueRefreshToken(userId, sessionId)
          const rotated = await rotateRefreshToken(issued.raw)
          await ageConsumedTokensPastGrace(userId)

          // An attacker who stole the old token replays it.
          await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

          // The whole family should die, the legitimate client's token included; with the guard mutated this query finds zero rows instead of one.
          const rotatedTokenRows = await sql`
            select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
              and revoked_at is not null and replaced_by_id is null
          `
          expect(rotatedTokenRows).toHaveLength(1)

          // From the client's side: that token can no longer be rotated; with the guard mutated it still can, so this resolves instead of rejecting.
          await expect(rotateRefreshToken(rotated.raw)).rejects.toMatchObject({
            statusCode: 401,
          })
        }
      )
    }
  )
})
