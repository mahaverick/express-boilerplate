/**
 * @file Proves that without the `purpose` predicate in `claimOnce`'s single
 * atomic statement, a token minted for one purpose can be claimed as another:
 * here a mailed step-up link is claimed as a refresh token, which would let a
 * link read out of a mailbox rotate into a session. The
 * always-green proof of this lives in
 * `tests/integration/repositories/user-token.repository.test.ts` and
 * `tests/integration/services/session.service.test.ts`; this file exists to
 * show those tests would actually catch a regression, same rationale and
 * two-test shape as `token-reuse-mutation.test.ts` and
 * `user-token-claim-atomicity.test.ts`.
 */
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

/**
 * A disposable email unique to this call, so it cannot collide with rows other tests in this
 * worker's database hold.
 */
function uniqueEmail(): string {
  return `claim-purpose-mutation-${randomUUID()}@example.test`
}

/**
 * A fresh 64-character hex string standing in for a SHA-256 token digest; this file never needs it to
 * correspond to a real raw token.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

/**
 * A `claimOnce` stand-in with no purpose predicate: it claims the unrevoked, non-deleted row
 * for a hash whatever its purpose, which is the bug under test. `_purpose` is accepted and ignored
 * only so the signature matches `claimOnce` for `withMutatedMethod`.
 */
async function purposeBlindClaimOnce(
  tokenHash: string,
  _purpose: TokenPurpose
): Promise<UserToken | undefined> {
  const [row] = await db
    .update(userTokenModel)
    .set({ revokedAt: sql`now()`, consumedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(userTokenModel.tokenHash, tokenHash),
        isNull(userTokenModel.revokedAt),
        isNull(userTokenModel.deletedAt)
      )
    )
    .returning()
  return row
}

/**
 * Inserts a live `step_up_link` row for `userId` under `tokenHash`.
 */
async function insertStepUpLink(userId: string, tokenHash: string): Promise<void> {
  await userTokenRepository.create({
    userId,
    purpose: 'step_up_link',
    sessionId: randomUUID(),
    email: uniqueEmail(),
    app: 'apex',
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  })
}

describe('mutation-test harness, proven on claimOnce’s purpose predicate', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await pgSql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates a user to own the token rows a test issues, tracked for cleanup, and returns its id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * Always on: mutates `claimOnce` to the purpose-blind predicate (tokenHash + revokedAt IS NULL,
   * no purpose check), shows a step-up link is claimable as a refresh token, then
   * shows a fresh token is rejected after the real method is restored.
   */
  it('a purpose-blind claimOnce lets a step-up link be claimed as a refresh token; restoring the predicate blocks it again', async () => {
    const userId = await createUser()

    // MUTATED: claimOnce ignores purpose entirely — under the real implementation this claim must be rejected; under this mutation it must succeed, exactly the vulnerability this predicate closes.
    const mutatedHash = uniqueHash()
    await insertStepUpLink(userId, mutatedHash)

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'claimOnce',
      purposeBlindClaimOnce,
      async () => {
        const wronglyClaimed = await userTokenRepository.claimOnce(mutatedHash, 'refresh')
        // The bug this proves: with the predicate gone, a step-up link is spendable as a refresh token.
        expect(wronglyClaimed).toBeDefined()
        expect(wronglyClaimed?.purpose).toBe('step_up_link')
      }
    )

    // RESTORED: a fresh token of the same shape, same sequence of calls, proves the predicate is back.
    const restoredHash = uniqueHash()
    await insertStepUpLink(userId, restoredHash)
    const correctlyRejected = await userTokenRepository.claimOnce(restoredHash, 'refresh')
    expect(correctlyRejected).toBeUndefined()
  })

  /**
   * Deliberately red under MUTATION_PROOF=1: reproduces the real "claimOnce
   * rejects a claim for a different purpose" assertion against the same
   * purpose-blind mutation. No file changes between the two runs
   * (`tests/helpers/mutate.ts`).
   *
   *   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/user-token-claim-purpose-mutation.test.ts   # red
   *   pnpm exec vitest run tests/integration/repositories/user-token-claim-purpose-mutation.test.ts                    # green
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "claimOnce rejects a claim for a different purpose" test’s own assertion against the purpose-blind mutation',
    async () => {
      const userId = await createUser()
      const tokenHash = uniqueHash()
      await insertStepUpLink(userId, tokenHash)

      await withMutatedMethod(
        UserTokenRepository.prototype,
        'claimOnce',
        purposeBlindClaimOnce,
        async () => {
          const wrongPurpose = await userTokenRepository.claimOnce(tokenHash, 'refresh')
          // The real test's own assertion, reproduced against the mutated, purpose-blind implementation — this is what goes red, not a hand-written stand-in.
          expect(wrongPurpose).toBeUndefined()
        }
      )
    }
  )
})
