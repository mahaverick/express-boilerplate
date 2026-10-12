/**
 * @file `revokeAllSessions` fails closed against a rotation in flight even
 * when its caller's transaction rolls back: a password reset whose locked
 * transaction fails must still leave no session alive and every session
 * denied, the successor token a concurrent rotation minted included. A seam
 * holds the rotation's transaction open after its claim; the reset is
 * started while it is held, and its write is made to fail so its locked pass
 * rolls back.
 *
 * The `MUTATION_PROOF` test is deliberately red; it keeps the assertions of
 * the test it reproduces:
 *
 * ```
 * MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/revoke-all-sessions-rollback.test.ts   # red
 * pnpm exec vitest run tests/integration/services/revoke-all-sessions-rollback.test.ts                    # green
 * ```
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { resetPassword } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { issueRefreshToken, issueToken, rotateRefreshToken } from '@/services/session.service'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const originalClaimOnce = UserTokenRepository.prototype.claimOnce.bind(new UserTokenRepository())
// eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
const realLockById = UserRepository.prototype.lockById

/**
 * Fails the reset's write inside its locked transaction, so that transaction rolls back.
 */
function failingUpdate(): Promise<never> {
  return Promise.reject(new Error('write failed'))
}

/**
 * `lockById` with the `FOR NO KEY UPDATE` lock replaced by a plain read, for
 * the mutation proof: `revokeAllSessions` then no longer waits for a
 * rotation's `FOR SHARE`.
 */
const unlockedExclusive: typeof realLockById = async function (this: UserRepository, id, mode, tx) {
  if (mode === 'share') return realLockById.call(this, id, mode, tx)
  return this.findById(id, {}, tx)
}

describe('revokeAllSessions against a rotation in flight', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Hold a rotation after its claim, run a reset whose locked transaction
   * rolls back, release the rotation, and assert its successor is revoked
   * and its session denied.
   * @param options - `unlockedRevoke` swaps the revoke's user row lock for a plain read.
   * @param options.unlockedRevoke - For the mutation proof only.
   */
  async function expectSuccessorRevoked(options: { unlockedRevoke?: boolean } = {}): Promise<void> {
    const user = await userRepository.create({
      email: `revoke-all-rollback-${randomUUID()}@example.test`,
      emailVerifiedAt: new Date(),
    })
    createdIds.push(user.id)
    const presented = await issueRefreshToken(user.id, randomUUID())
    const reset = await issueToken(user.id, 'password_reset', 60_000)

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

        await withMutatedMethod(UserRepository.prototype, 'update', failingUpdate, async () => {
          const resetting = resetPassword({
            token: reset.raw,
            password: 'a brand new long passphrase',
          })
          expect(await waitForWaiter(rotationPid, resetting)).toBe(true)
          release.resolve()
          const successor = await rotation

          await expect(resetting).rejects.toThrow('write failed')

          // Before the rotation below, whose reuse kill would deny the session itself.
          expect(await isSessionDenied(successor.sessionId)).toBe(true)
          await expect(rotateRefreshToken(successor.raw)).rejects.toMatchObject({
            statusCode: 401,
          })
        })
      })
    })
  }

  it("revokes and denies the rotation's successor even when the reset's transaction rolls back", async () => {
    await expectSuccessorRevoked()
  })

  /**
   * Deliberately red under `MUTATION_PROOF=1`: with no user row lock, the
   * revoke's snapshot never sees the successor the held rotation inserts,
   * and the reset's locked pass that would catch it rolls back.
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the rollback test with a revokeAllSessions that takes no user row lock',
    async () => {
      await expectSuccessorRevoked({ unlockedRevoke: true })
    }
  )
})
