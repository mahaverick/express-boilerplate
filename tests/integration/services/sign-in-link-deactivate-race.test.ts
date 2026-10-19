/**
 * @file A deactivation that commits while a sign-in link's verify is between
 * its account checks and its session insert wins: the verify re-reads the
 * user under its row lock, sees the account inactive, and issues nothing.
 * The same holds for a soft delete. Seams via withMutatedMethod, no sleeps.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LINK_INVALID_CODE } from '@/constants/auth.constants'
import type { NewUser } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { verifySignInLink } from '@/services/sign-in-link.service'
import { deferred, untilSignalled } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { issueTestLink } from '../../helpers/sign-in'

afterEach(async () => {
  await deleteTrackedUsers()
})

/**
 * Runs a verify that pauses at its `lastLoggedInAt` write, applies `change`
 * while it waits, lets it continue and returns how it settled. `change` is a
 * committed account change such as a deactivation.
 */
async function verifyAround(
  raw: string,
  change: () => Promise<void>
): Promise<PromiseSettledResult<unknown>> {
  const reached = deferred()
  const release = deferred()
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realUpdate = UserRepository.prototype.update
  /**
   * Stands in for `UserRepository.update`: it blocks the `lastLoggedInAt` write until released and
   * signals when it gets there.
   */
  const pausingUpdate: typeof realUpdate = async function (this: UserRepository, ...arguments_) {
    const [, fields] = arguments_
    if ((fields as Partial<NewUser>).lastLoggedInAt !== undefined) {
      reached.resolve()
      await release.promise
    }
    return realUpdate.apply(this, arguments_)
  }
  let settled: PromiseSettledResult<unknown> | undefined
  await withMutatedMethod(UserRepository.prototype, 'update', pausingUpdate, async () => {
    const verifying = verifySignInLink(raw)
    await untilSignalled(reached.promise, verifying, 'verify')
    await change()
    release.resolve()
    const results = await Promise.allSettled([verifying])
    settled = results[0]
  })
  if (!settled) throw new Error('the verify never settled')
  return settled
}

/**
 * Counts a user's refresh-token rows, zero after a refused sign-in, one after an allowed one.
 */
async function refreshRows(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens where user_id = ${userId} and purpose = 'refresh'
  `
  return row?.count ?? 0
}

describe('sign-in link verify vs a concurrent deactivation', () => {
  it('refuses the verify with LINK_INVALID and issues no session when the account is deactivated mid-verify', async () => {
    const user = await createTrackedUser()
    const raw = await issueTestLink(user.email)

    const settled = await verifyAround(raw, async () => {
      await sql`update users set active = false where id = ${user.id}`
    })

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 400,
      code: LINK_INVALID_CODE,
    })
    expect(await refreshRows(user.id)).toBe(0)
  })

  it('refuses the verify when the account is soft-deleted mid-verify', async () => {
    const user = await createTrackedUser()
    const raw = await issueTestLink(user.email)

    const settled = await verifyAround(raw, async () => {
      await sql`update users set deleted_at = now() where id = ${user.id}`
    })

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({ code: LINK_INVALID_CODE })
    expect(await refreshRows(user.id)).toBe(0)
  })

  it('still signs in when nothing changes mid-verify', async () => {
    const user = await createTrackedUser()
    const raw = await issueTestLink(user.email)

    const settled = await verifyAround(raw, async () => {})

    expect(settled.status).toBe('fulfilled')
    expect(await refreshRows(user.id)).toBe(1)
  })
})
