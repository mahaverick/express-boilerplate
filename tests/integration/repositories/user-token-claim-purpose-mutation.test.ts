/**
 * @file Proves that without the `purpose` predicate in `claimOnce`'s single
 * atomic statement, a token minted for one purpose can be claimed as another:
 * here a password-reset token is claimed as an email verification. The same
 * gap would let a verification token, which proves only mailbox access, be
 * spent as a password reset, which stores a new password for the account. The
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
 * A fresh `@example.test` address per call, so users from different tests never share an email.
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

describe('mutation-test harness, proven on claimOnce’s purpose predicate', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await pgSql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates a user for a test, tracked for cleanup, and returns its id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * Always on: mutates `claimOnce` to the purpose-blind predicate (tokenHash + revokedAt IS NULL,
   * no purpose check), shows a password-reset token is claimable as an email verification, then
   * shows a fresh token is rejected after the real method is restored.
   */
  it('a purpose-blind claimOnce lets a password-reset token be claimed as an email verification; restoring the predicate blocks it again', async () => {
    const userId = await createUser()

    // MUTATED: claimOnce ignores purpose entirely — under the real implementation this claim must be rejected; under this mutation it must succeed, exactly the vulnerability this predicate closes.
    const mutatedHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash: mutatedHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'claimOnce',
      purposeBlindClaimOnce,
      async () => {
        const wronglyClaimed = await userTokenRepository.claimOnce(
          mutatedHash,
          'email_verification'
        )
        // The bug this proves: with the predicate gone, a reset token is spendable as a verification.
        expect(wronglyClaimed).toBeDefined()
        expect(wronglyClaimed?.purpose).toBe('password_reset')
      }
    )

    // RESTORED: a fresh token of the same shape, same sequence of calls, proves the predicate is back.
    const restoredHash = uniqueHash()
    await userTokenRepository.create({
      userId,
      purpose: 'password_reset',
      tokenHash: restoredHash,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const correctlyRejected = await userTokenRepository.claimOnce(
      restoredHash,
      'email_verification'
    )
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
      await userTokenRepository.create({
        userId,
        purpose: 'password_reset',
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await withMutatedMethod(
        UserTokenRepository.prototype,
        'claimOnce',
        purposeBlindClaimOnce,
        async () => {
          const wrongPurpose = await userTokenRepository.claimOnce(tokenHash, 'email_verification')
          // The real test's own assertion, reproduced against the mutated, purpose-blind implementation — this is what goes red, not a hand-written stand-in.
          expect(wrongPurpose).toBeUndefined()
        }
      )
    }
  )
})
