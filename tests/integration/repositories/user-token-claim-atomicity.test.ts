/**
 * @file Proves `claimOnce`'s check-then-write is a single atomic statement,
 * so two concurrent callers presenting the same token hash can never both
 * win the claim — with real, concurrent database traffic, not sequential
 * assertions, which cannot observe a TOCTOU race at all.
 * Two tests, same shape as
 * `tests/integration/services/token-reuse-mutation.test.ts`.
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
import { deferred } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * The test pool's size (`DB_POOL_MAX=2` in `.env.test`), so both claims below are genuinely
 * concurrent at the database, not issued concurrently from Node and then serialised waiting for a
 * free connection.
 */
const CONCURRENT_CLAIMS = 2

/**
 * A fresh `@example.test` address per call, so users from different tests never share an email.
 */
function uniqueEmail(): string {
  return `claim-atomicity-${randomUUID()}@example.test`
}

/**
 * A fresh 64-character hex string standing in for a SHA-256 token digest; this file never needs it to
 * correspond to a real raw token.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

/**
 * A barrier for `parties` callers: `arrive()` resolves once all of them have called it.
 */
function meetingPoint(parties: number): { arrive: () => Promise<void> } {
  let arrivals = 0
  const opened = deferred()
  return {
    arrive: async () => {
      arrivals += 1
      if (arrivals >= parties) opened.resolve()
      await opened.promise
    },
  }
}

/**
 * A non-atomic stand-in for `claimOnce`, with the TOCTOU shape its single UPDATE statement exists
 * to rule out: a SELECT checking `revokedAt IS NULL`, then a separate UPDATE. Every caller meets at
 * `meeting` between the two, so concurrent callers all pass the check before any writes.
 * `this.scope` and `this.touched` are `protected` on BaseRepository, so the WHERE and SET clauses
 * are inlined; they otherwise match `claimOnce`'s predicate (tokenHash, purpose, `revokedAt IS
 * NULL`, not soft-deleted).
 */
function unsafeClaimOnce(
  meeting: ReturnType<typeof meetingPoint>
): (tokenHash: string, purpose: TokenPurpose) => Promise<UserToken | undefined> {
  return async (tokenHash, purpose) => {
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
    // Before the early return, so a caller that found nothing cannot strand the other.
    await meeting.arrive()
    if (!found) return

    const [updated] = await db
      .update(userTokenModel)
      .set({ revokedAt: sql`now()`, consumedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(userTokenModel.id, found.id))
      .returning()
    return updated
  }
}

/**
 * Fires `times` concurrent `claimOnce` calls at the same hash and purpose and waits for all of
 * them. The result has one entry per caller, undefined for each one that lost the race.
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
   * Creates a user to own the token row the concurrent claims race for, tracked for cleanup, and
   * returns its id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * Always on: races `CONCURRENT_CLAIMS` parallel `claimOnce` calls (one per pool connection, so
   * they genuinely run at the database at once) against one row. Postgres's own MVCC UPDATE
   * semantics make exactly one winner deterministic.
   */
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

    // Exactly one: "at least one" passes when every caller wins, and "at most one" passes when none does.
    expect(claimed).toHaveLength(1)

    const finalRow = await userTokenRepository.findByHash(tokenHash)
    // Asserted before the field checks below: finalRow?.revokedAt alone passes when finalRow is undefined too.
    expect(finalRow).toBeDefined()
    expect(finalRow?.revokedAt).not.toBeNull()
    expect(finalRow?.consumedAt).not.toBeNull()
  })

  /**
   * Deliberately red under MUTATION_PROOF=1: swaps `claimOnce` for a
   * non-atomic select-then-update stand-in, with both callers meeting at a
   * barrier between their SELECT and their UPDATE, and reproduces the
   * always-on test's own assertion against it. No file changes between the
   * two runs (`tests/helpers/mutate.ts`).
   *
   *   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/user-token-claim-atomicity.test.ts   # red
   *   pnpm exec vitest run tests/integration/repositories/user-token-claim-atomicity.test.ts                    # green
   */
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
        unsafeClaimOnce(meetingPoint(CONCURRENT_CLAIMS)),
        async () => {
          const results = await claimConcurrently(tokenHash, 'password_reset', CONCURRENT_CLAIMS)
          const claimed = results.filter((row): row is UserToken => row !== undefined)

          // The real test's own assertion, reproduced against the mutated, non-atomic implementation — this is what goes red, not a hand-written stand-in.
          expect(claimed).toHaveLength(1)
        }
      )
    }
  )
})
