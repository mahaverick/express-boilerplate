/**
 * @file An account claim (`claimNeverVerifiedAccount`) fails closed against a
 * rotation in flight even when its claiming transaction rolls back: its first
 * pass revokes every session in a committed transaction of its own, so a
 * claim whose locked write fails must still leave no session alive and every
 * session denied, the successor token a concurrent rotation minted included.
 * A seam holds the rotation's transaction open after its claim; the account
 * claim is started while it is held, and its in-lock write is made to fail so
 * its second pass rolls back.
 *
 * The `MUTATION_PROOF` test is deliberately red; it keeps the assertions of
 * the test it reproduces:
 *
 * ```
 * MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/account-claim-rollback.test.ts   # red
 * pnpm exec vitest run tests/integration/services/account-claim-rollback.test.ts                    # green
 * ```
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { claimNeverVerifiedAccount } from '@/services/account-claim.service'
import { sql } from '@/services/database.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { issueRefreshToken, rotateRefreshToken } from '@/services/session.service'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const originalClaimOnce = UserTokenRepository.prototype.claimOnce.bind(new UserTokenRepository())
// oxlint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
const realLockById = UserRepository.prototype.lockById

/**
 * Fails the claim's write inside its locked transaction, so that transaction rolls back.
 */
function failingWrite(): Promise<never> {
  return Promise.reject(new Error('write failed'))
}

/**
 * `lockById` with the `FOR NO KEY UPDATE` lock replaced by a plain read, for
 * the mutation proof: the claim's first pass then no longer waits for a
 * rotation's `FOR SHARE`.
 */
const unlockedExclusive: typeof realLockById = async function (this: UserRepository, id, mode, tx) {
  if (mode === 'share') return realLockById.call(this, id, mode, tx)
  return this.findById(id, {}, tx)
}

describe('an account claim against a rotation in flight', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Hold a rotation after its claim, run an account claim whose locked
   * transaction rolls back, release the rotation, and assert its successor
   * is revoked and its session denied.
   * @param options - `unlockedRevoke` swaps the revoke's user row lock for a plain read.
   * @param options.unlockedRevoke - For the mutation proof only.
   */
  async function expectSuccessorRevoked(options: { unlockedRevoke?: boolean } = {}): Promise<void> {
    const user = await userRepository.create({
      email: `account-claim-rollback-${randomUUID()}@example.test`,
    })
    createdIds.push(user.id)
    const presented = await issueRefreshToken(user.id, randomUUID())

    const reachedClaim = deferred<number>()
    const release = deferred()
    /**
     * The real claim, then, for a refresh token only, report this
     * transaction's backend and hold it open until released.
     */
    const heldClaim: UserTokenRepository['claimOnce'] = async (tokenHash, purpose, executor) => {
      const claimed = await originalClaimOnce(tokenHash, purpose, executor)
      if (purpose === 'refresh' && executor !== undefined) {
        reachedClaim.resolve(await backendPid(executor))
        await release.promise
      }
      return claimed
    }
    const lockById = options.unlockedRevoke ? unlockedExclusive : realLockById

    await withMutatedMethod(UserRepository.prototype, 'lockById', lockById, async () => {
      await withMutatedMethod(UserTokenRepository.prototype, 'claimOnce', heldClaim, async () => {
        const rotation = rotateRefreshToken(presented.raw)
        const rotationPid = await untilSignalled(reachedClaim.promise, rotation, 'the rotation')

        const claiming = claimNeverVerifiedAccount(user.id, failingWrite)
        expect(await waitForWaiter(rotationPid, claiming)).toBe(true)
        release.resolve()
        const successor = await rotation

        await expect(claiming).rejects.toThrow('write failed')

        // Before the rotation below, whose reuse kill would deny the session itself.
        expect(await isSessionDenied(successor.sessionId)).toBe(true)
        await expect(rotateRefreshToken(successor.raw)).rejects.toMatchObject({
          statusCode: 401,
        })
      })
    })
  }

  it("revokes and denies the rotation's successor even when the claim's transaction rolls back", async () => {
    await expectSuccessorRevoked()
  })

  /**
   * Deliberately red under `MUTATION_PROOF=1`: with no user row lock, the
   * revoke's snapshot never sees the successor the held rotation inserts,
   * and the claim's locked pass that would catch it rolls back.
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the rollback test with a claim whose first pass takes no user row lock',
    async () => {
      await expectSuccessorRevoked({ unlockedRevoke: true })
    }
  )
})
