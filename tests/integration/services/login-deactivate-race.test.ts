/**
 * @file A deactivation that commits while a login is between its password
 * compare and its session insert wins: the login re-reads the user under
 * its row lock, sees the account inactive, and issues nothing. The same
 * holds for a soft delete. Seams via withMutatedMethod, no sleeps.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewUser } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { login } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { hashPassword } from '@/utilities/password.utilities'
import { deferred, untilSignalled } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const PASSWORD = 'correct horse battery staple'
const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

/**
 * Creates a verified user with a password, deleted in `afterEach`, to log in as.
 */
async function createVerifiedUser(): Promise<{ id: string; email: string }> {
  const email = `login-race-${randomUUID()}@example.test`
  const user = await userRepository.create({ email, passwordHash: await hashPassword(PASSWORD) })
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  return { id: user.id, email }
}

/**
 * Runs a login that pauses at its `lastLoggedInAt` write, applies `change`
 * while it waits, lets it continue and returns how it settled. `change` is a
 * committed account change such as a deactivation.
 */
async function loginAround(
  email: string,
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
    const loggingIn = login({ email, password: PASSWORD })
    await untilSignalled(reached.promise, loggingIn, 'login')
    await change()
    release.resolve()
    const results = await Promise.allSettled([loggingIn])
    settled = results[0]
  })
  if (!settled) throw new Error('the login never settled')
  return settled
}

/**
 * Counts a user's refresh-token rows, which a refused login must leave at zero.
 */
async function refreshRows(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens where user_id = ${userId} and purpose = 'refresh'
  `
  return row?.count ?? 0
}

describe('login vs a concurrent deactivation', () => {
  it('refuses the login and issues no session when the account is deactivated mid-login', async () => {
    const user = await createVerifiedUser()

    const settled = await loginAround(user.email, async () => {
      await sql`update users set active = false where id = ${user.id}`
    })

    expect(settled.status).toBe('rejected')
    expect((settled as PromiseRejectedResult).reason).toMatchObject({ statusCode: 401 })
    expect(await refreshRows(user.id)).toBe(0)
  })

  it('refuses the login when the account is soft-deleted mid-login', async () => {
    const user = await createVerifiedUser()

    const settled = await loginAround(user.email, async () => {
      await sql`update users set deleted_at = now() where id = ${user.id}`
    })

    expect(settled.status).toBe('rejected')
    expect(await refreshRows(user.id)).toBe(0)
  })

  it('still logs in when nothing changes mid-login', async () => {
    const user = await createVerifiedUser()
    const settled = await loginAround(user.email, async () => {})
    expect(settled.status).toBe('fulfilled')
    expect(await refreshRows(user.id)).toBe(1)
  })
})
