// tests/integration/repositories/user-token-claim-purpose-mutation.test.ts
//
// Proves the property task-1-brief.md calls "the test that matters most":
// without the `purpose` predicate participating in claimOnce's single
// atomic statement, a password-reset token could be claimed as an email
// verification, or worse — turning "I can receive mail at this address"
// into "I can take over this account." The real, always-green proof of
// this lives in tests/integration/repositories/user-token.repository.test.ts
// ("claimOnce rejects a claim for a different purpose...") and
// tests/integration/utilities/token.utilities.test.ts ("rejects claiming a
// password-reset token as an email verification..."); THIS file exists to
// show those tests would actually catch a regression, not just that they
// pass today — same rationale, same two-test shape, as
// token-reuse-mutation.test.ts and user-token-claim-atomicity.test.ts.
//
//   1. Always on: mutate claimOnce to the exact predicate claimForRotation
//      used before this task (tokenHash + revokedAt IS NULL — no purpose
//      check at all), show a password-reset token is claimable as an email
//      verification, then let the harness restore the real implementation
//      and show a FRESH token of the same shape is correctly rejected.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red
//      under that flag: reproduces, assertion for assertion, the real
//      "claimOnce rejects a claim for a different purpose" test's own
//      `expect(...).toBeUndefined()` against the same purpose-blind
//      mutation.
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/user-token-claim-purpose-mutation.test.ts   # red
//        pnpm exec vitest run tests/integration/repositories/user-token-claim-purpose-mutation.test.ts                    # green
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

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `claim-purpose-mutation-${randomUUID()}@example.test`
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
 * `claimForRotation`'s exact pre-task-1 predicate: claims the first
 * not-yet-revoked row for a hash, regardless of purpose. `_purpose` is
 * accepted (and ignored) only so this matches `claimOnce`'s signature for
 * `withMutatedMethod`.
 * @param tokenHash - The SHA-256 hash of the raw token, hex-encoded.
 * @param _purpose - Unused — this is exactly the bug: no purpose predicate at all.
 * @returns The claimed row, or undefined when no live row matched.
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
   * Create a disposable user row for a test and track it for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  it('a purpose-blind claimOnce lets a password-reset token be claimed as an email verification; restoring the predicate blocks it again', async () => {
    const userId = await createUser()

    // MUTATED: claimOnce ignores purpose entirely — claimForRotation's old
    // behaviour. A password-reset token must NOT be claimable as an email
    // verification under the real implementation; under this mutation, it
    // must be, which is exactly the vulnerability this predicate closes.
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
        // The bug this proves: with the predicate gone, a reset token is
        // spendable as a verification.
        expect(wronglyClaimed).toBeDefined()
        expect(wronglyClaimed?.purpose).toBe('password_reset')
      }
    )

    // RESTORED: a fresh token of the same shape, same sequence of calls,
    // proves the predicate is back.
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

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is
  // green.
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
          // The real test's own assertion, reproduced against the mutated,
          // purpose-blind implementation — this is what goes red, not a
          // hand-written stand-in for it.
          expect(wrongPurpose).toBeUndefined()
        }
      )
    }
  )
})
