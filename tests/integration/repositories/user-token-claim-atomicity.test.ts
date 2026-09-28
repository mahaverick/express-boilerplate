/**
 * @file Proves `claimOnce`'s check-then-write is a single atomic statement,
 * so two concurrent callers presenting the same token hash can never both
 * win the claim — with real, concurrent database traffic, not sequential
 * assertions, which cannot observe a TOCTOU race at all (see CLAUDE.md).
 * Two tests, same shape as
 * `tests/integration/services/token-reuse-mutation.test.ts`: an always-on
 * test races `CONCURRENT_CLAIMS` truly-parallel `claimOnce` calls (matching
 * the test-mode pool's own `max: 2`, so both genuinely run at the database
 * at once) against one row, where Postgres's own MVCC UPDATE semantics make
 * exactly one winner deterministic; and a `MUTATION_PROOF` test that swaps
 * `claimOnce` for a non-atomic select-then-update stand-in — with both
 * callers meeting at a barrier between their SELECT and their UPDATE — and
 * reproduces the same assertion against it, deliberately red
 * (`MUTATION_PROOF=1 pnpm exec vitest run <this file>`; no file changes
 * between the two runs, per `tests/helpers/mutate.ts`).
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
 * Matches `database.service.ts`'s own test-mode pool size (`max: 2`)
 * exactly, so both claims below are guaranteed genuinely concurrent at the
 * database, not merely issued concurrently from Node and then serialised
 * waiting for a free connection.
 */
const CONCURRENT_CLAIMS = 2

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
 * A barrier for `parties` callers: `arrive()` resolves once all of them have called it.
 * @param parties - How many callers must arrive.
 * @returns The barrier.
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
 * The exact TOCTOU shape `claimOnce`'s single UPDATE statement exists to
 * rule out: a separate SELECT to check `revokedAt IS NULL`, THEN a separate
 * UPDATE — with every caller meeting at `meeting` between them, so
 * concurrent callers all pass the check before any writes. Cannot use
 * `this.scope`/`this.touched` (both `protected` on BaseRepository): the
 * WHERE and SET clauses are inlined instead, otherwise matching claimOnce's
 * own real predicate exactly (tokenHash + purpose + revokedAt IS NULL + not
 * soft-deleted).
 * @param meeting - The barrier every concurrent caller meets at after its SELECT.
 * @returns A non-atomic stand-in for `claimOnce`.
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

    // Not "at least one" or "at most one": asserting the count, not just non-emptiness, is what would catch a regression that let every caller win.
    expect(claimed).toHaveLength(1)

    const finalRow = await userTokenRepository.findByHash(tokenHash)
    // Asserted before the field checks below: finalRow?.revokedAt alone passes when finalRow is undefined too.
    expect(finalRow).toBeDefined()
    expect(finalRow?.revokedAt).not.toBeNull()
    expect(finalRow?.consumedAt).not.toBeNull()
  })

  // Deliberately red under MUTATION_PROOF=1 (see this file's @file doc); left unset, this test is skipped and the file is green.
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
