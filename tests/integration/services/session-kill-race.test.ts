/**
 * @file A session kill whose transaction begins before a rotation's claim but
 * takes the user-row lock after that rotation commits. The kill still revokes
 * the rotation's new token, and a replay of the rotated token inside the grace
 * window must still be refused: the kill marker has to read as later than the
 * claim, though the kill's transaction started first. The rotation is run
 * from inside `UserRepository.lockById` (swapped with `withMutatedMethod`), so
 * it lands after the kill's BEGIN and before its lock, every time.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import type { DbTransaction } from '@/services/database.service'
import { signOutUser } from '@/services/platform-user.service'
import {
  issueRefreshToken,
  revokeOtherSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { isTokenRowLive } from '../../helpers/grace-sibling'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

/**
 * A session one rotation in, so its head can be rotated once more and then replayed.
 * @param user - The session's user.
 * @returns The live head.
 */
async function rotatedSession(user: User): Promise<IssuedRefreshToken> {
  const first = await issueRefreshToken(user.id, randomUUID())
  return rotateRefreshToken(first.raw)
}

/**
 * Run `kill` with a rotation of `raw` slipped in when the kill asks for the
 * user row FOR NO KEY UPDATE: after its transaction began, before its lock.
 * @param userId - The user whose row the kill locks.
 * @param raw - The refresh token the slipped-in rotation consumes.
 * @param kill - The kill under test.
 * @returns The token the slipped-in rotation minted.
 */
async function killWithRotationBeforeLock(
  userId: string,
  raw: string,
  kill: () => Promise<unknown>
): Promise<IssuedRefreshToken> {
  const prototype = UserRepository.prototype
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
  const original = prototype.lockById
  let minted: IssuedRefreshToken | undefined
  /**
   * `lockById` that first rotates `raw` on another connection, once, for the kill's lock.
   * @param id - The user id to lock.
   * @param mode - The row-lock strength.
   * @param tx - The kill's transaction, already begun.
   * @returns The locked row, as the original returns it.
   */
  async function lockAfterRotation(
    this: UserRepository,
    id: string,
    mode: 'no key update' | 'share',
    tx: DbTransaction
  ): Promise<User | undefined> {
    if (minted === undefined && id === userId && mode === 'no key update') {
      minted = await rotateRefreshToken(raw)
    }
    return original.call(this, id, mode, tx)
  }
  await withMutatedMethod(prototype, 'lockById', lockAfterRotation, async () => {
    await kill()
  })
  if (minted === undefined) throw new Error('the kill never locked the user row')
  return minted
}

describe('a kill that began before a rotation’s claim', () => {
  it('logout: the replay inside the grace window is refused, and the session stays dead', async () => {
    const user = await createTrackedUser()
    const head = await rotatedSession(user)

    const minted = await killWithRotationBeforeLock(user.id, head.raw, () =>
      revokeRefreshToken(head.raw)
    )

    expect(await isTokenRowLive(minted.raw)).toBe(false)
    await expect(rotateRefreshToken(head.raw)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('sign-out of other sessions from another session: the replay is refused', async () => {
    const user = await createTrackedUser()
    const head = await rotatedSession(user)
    const elsewhere = await issueRefreshToken(user.id, randomUUID())

    const minted = await killWithRotationBeforeLock(user.id, head.raw, () =>
      revokeOtherSessions(user.id, elsewhere.sessionId)
    )

    expect(await isTokenRowLive(minted.raw)).toBe(false)
    await expect(rotateRefreshToken(head.raw)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('a staff sign-out: the replay is refused', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const user = await createTrackedUser()
    const head = await rotatedSession(user)

    const minted = await killWithRotationBeforeLock(user.id, head.raw, () =>
      signOutUser({ userId: admin.id }, user.id, 'kill race test')
    )

    expect(await isTokenRowLive(minted.raw)).toBe(false)
    await expect(rotateRefreshToken(head.raw)).rejects.toMatchObject({ statusCode: 401 })
  })
})
