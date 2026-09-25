// tests/integration/services/token-reuse-mutation.test.ts
//
// B3 Task 0, Step 3: prove the mutation-test harness (tests/helpers/mutate.ts)
// on a REAL security behaviour, against the real per-worker Postgres
// database — not a toy. The candidate is reuse detection
// (rotateRefreshToken, session.service.ts): presenting an already-rotated
// refresh token must revoke every token in its session family, containing a
// stolen token the instant its holder tries to use it. The single call that
// makes this true is `UserTokenRepository.prototype.revokeAllForSession`
// (see rotateRefreshToken's own header comment). It is also the exact call
// `revokeRefreshToken` (logout) makes — mutating it here disables both of
// B2's "reuse not detected" and "logout not revoking" alerts at once.
//
// Two tests:
//
//   1. Always on, both directions in one run: mutate the guard, show the
//      family survives an attack it should have killed, then let the
//      harness restore it and show a FRESH family does not survive the same
//      attack. This is what `pnpm test` and CI run, and it is always green
//      — it is a regression test for the harness's integration with real
//      security code, not a demonstration of red output.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red
//      under that flag: it reproduces, assertion for assertion, the real
//      "detects reuse" test (tests/integration/services/session.service.test.ts)
//      against the same mutated guard, so the failure shown is the actual
//      regression test failing — not a hand-written stand-in for it.
//      Skipped by default, so the file is green under `pnpm test`/CI without
//      anyone editing anything:
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/token-reuse-mutation.test.ts   # red
//        pnpm exec vitest run tests/integration/services/token-reuse-mutation.test.ts                    # green
//
//      No file changes between the two runs — only the environment variable
//      differs — and `git status --porcelain` stays empty throughout.
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
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `mutation-proof-${randomUUID()}@example.test`
}

/**
 * Age a user's consumed tokens past REFRESH_REUSE_GRACE_MS so a replay counts as reuse.
 * @param userId - The user whose consumed tokens are aged.
 */
async function ageConsumedTokensPastGrace(userId: string): Promise<void> {
  await sql`
    update user_tokens set consumed_at = consumed_at - interval '11 seconds'
    where user_id = ${userId} and consumed_at is not null
  `
}

describe('mutation-test harness, proven on reuse detection', () => {
  // Same pattern as session.service.test.ts: track every created user id and
  // delete them in afterEach. Deleting the user cascades (ON DELETE CASCADE
  // on user_tokens.user_id) to every token row it owns, so nothing from this
  // file's mutation proofs is left behind in the shared per-worker database.
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

  it('disabling revokeAllForSession lets a reused token survive; restoring it brings reuse detection back', async () => {
    const userId = await createUser()

    // MUTATED: revokeAllForSession is a no-op. rotateRefreshToken still
    // rejects the reused token itself — claimOnce already finds it revoked
    // (and its purpose matches, since only a genuine 'refresh' token is
    // used here), and that throw is unconditional — but the tell is whether
    // the FAMILY survives. It must not.
    const mutatedSessionId = randomUUID()
    const issued = await issueRefreshToken(userId, mutatedSessionId)
    const rotated = await rotateRefreshToken(issued.raw)
    await ageConsumedTokensPastGrace(userId)

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'revokeAllForSession',
      async () => {},
      async () => {
        await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

        // The bug this proves: with the guard disabled, the token the
        // legitimate client is actually holding is STILL usable — the
        // attack that should have ended the session did nothing.
        const stillRotatable = await rotateRefreshToken(rotated.raw)
        expect(stillRotatable.sessionId).toBe(mutatedSessionId)
      }
    )

    // RESTORED: a fresh family proves the guard is back, using the exact
    // same sequence of calls.
    const restoredSessionId = randomUUID()
    const issuedAfterRestore = await issueRefreshToken(userId, restoredSessionId)
    const rotatedAfterRestore = await rotateRefreshToken(issuedAfterRestore.raw)
    await ageConsumedTokensPastGrace(userId)

    await expect(rotateRefreshToken(issuedAfterRestore.raw)).rejects.toMatchObject({
      statusCode: 401,
    })
    // This time the family did not survive: the token the legitimate
    // client was holding is dead too.
    await expect(rotateRefreshToken(rotatedAfterRestore.raw)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is green.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "detects reuse" test’s own assertions against the mutated guard',
    async () => {
      const userId = await createUser()
      const sessionId = randomUUID()

      await withMutatedMethod(
        UserTokenRepository.prototype,
        'revokeAllForSession',
        async () => {},
        async () => {
          const issued = await issueRefreshToken(userId, sessionId)
          const rotated = await rotateRefreshToken(issued.raw)
          await ageConsumedTokensPastGrace(userId)

          // Someone else — an attacker who stole the old token — presents
          // the OLD token again.
          await expect(rotateRefreshToken(issued.raw)).rejects.toMatchObject({ statusCode: 401 })

          // The whole family should be dead: the token the LEGITIMATE
          // client is now holding must also be revoked, even though it was
          // never itself misused. With the guard mutated, it is not — this
          // query finds zero rows instead of one.
          const rotatedTokenRows = await sql`
            select token_hash from user_tokens where user_id = ${userId} and session_id = ${sessionId}
              and revoked_at is not null and replaced_by_id is null
          `
          expect(rotatedTokenRows).toHaveLength(1)

          // Confirmed from the client's perspective too: the token that was
          // still valid a moment ago can no longer be rotated. With the
          // guard mutated, it still can be — this resolves instead of
          // rejecting.
          await expect(rotateRefreshToken(rotated.raw)).rejects.toMatchObject({
            statusCode: 401,
          })
        }
      )
    }
  )
})
