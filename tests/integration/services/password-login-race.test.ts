// tests/integration/services/password-login-race.test.ts
//
// A login that compared the old hash must not keep a session past a password
// change or reset. login re-reads the hash FOR SHARE in the transaction that
// issues its token; change and reset lock the user row, store the hash and
// revoke sessions in one transaction. Each flow is raced in both orders on the
// pool's two connections, and pg_blocking_pids (lock-probe.ts) shows the
// second side waited. Two logins are raced too: one holds FOR SHARE while the
// other finishes without waiting. There are no sleeps.
//
// Seams, all through withMutatedMethod:
// - login pauses after its lastLoggedInAt UPDATE, the one call between the
//   compare and its transaction;
// - UserRepository.lockById reports each side's backend pid, and can hold
//   login after it has taken FOR SHARE;
// - the password side's session revoke can hold after it has run, inside the
//   transaction.
//
// The MUTATION_PROOF tests below are deliberately red; each keeps the
// assertions of the test it reproduces:
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/password-login-race.test.ts   # red
//   pnpm exec vitest run tests/integration/services/password-login-race.test.ts                    # green
//
// Pool note: test mode has max 2 connections and each race holds both. A
// repository call inside login, changePassword or resetPassword that skipped
// `tx` would hang until waitForBlocked gives up.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/database/models/user.model'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { changePassword, login, resetPassword, type LoginResult } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { hashToken, issueRefreshToken, issueToken } from '@/services/session.service'
import { hashPassword, isPasswordValid } from '@/utilities/password.utilities'
import { backendPid, deferred, untilSignalled, waitForBlocked } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'

const userRepository = new UserRepository()
const OLD_PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new secret passphrase'
const DENYLIST_FAILURE = 'session denylist write failed after password change'

type PasswordFlow = 'change' | 'reset'

const createdIds: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A verified user whose password is OLD_PASSWORD, tracked for cleanup.
 * @returns The user.
 */
async function seedUser(): Promise<User> {
  const user = await userRepository.create({
    email: `password-race-${randomUUID()}@example.test`,
    passwordHash: await hashPassword(OLD_PASSWORD),
  })
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  return user
}

/**
 * Everything the password side needs, prepared before the race so the race
 * itself makes no extra pool queries.
 * @param flow - Change (from a session that is spared) or reset (with a token).
 * @param user - The user.
 * @returns A thunk that runs the password write.
 */
async function preparePasswordWrite(flow: PasswordFlow, user: User): Promise<() => Promise<void>> {
  if (flow === 'change') {
    const callerSessionId = randomUUID()
    return () =>
      changePassword(user.id, callerSessionId, {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      })
  }
  const { raw } = await issueToken(user.id, 'password_reset', 60_000)
  return () => resetPassword({ token: raw, password: NEW_PASSWORD })
}

/**
 * One method replacement, applied around `run`.
 */
type Mutation = (run: () => Promise<void>) => Promise<void>

/**
 * Apply every mutation, outermost first, around `run`.
 * @param mutations - The replacements.
 * @param run - The race.
 * @returns Resolves once `run` settles and every method is restored.
 */
async function withMutations(mutations: Mutation[], run: () => Promise<void>): Promise<void> {
  const [first, ...rest] = mutations
  if (!first) return run()
  return first(() => withMutations(rest, run))
}

/**
 * Replace both user-wide revoke methods with ones that, once `isArmed()` is
 * true, hold after running until `release` resolves. The password side arms
 * it when it takes the user row lock, so only the revoke inside that
 * transaction holds; reset's earlier revoke runs through.
 * @param revoked - Called once an armed revoke has run.
 * @param release - Awaited before an armed revoke returns.
 * @param isArmed - Whether the password side holds the user row lock yet.
 * @returns The two mutations.
 */
function holdAfterRevoke(
  revoked: () => void,
  release: Promise<void>,
  isArmed: () => boolean
): Mutation[] {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realAll = UserTokenRepository.prototype.revokeAllForUser
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realExcept = UserTokenRepository.prototype.revokeAllForUserExceptSession
  const holdingAll: typeof realAll = async function (this: UserTokenRepository, ...parameters) {
    const ids = await realAll.apply(this, parameters)
    if (isArmed()) {
      revoked()
      await release
    }
    return ids
  }
  const holdingExcept: typeof realExcept = async function (
    this: UserTokenRepository,
    ...parameters
  ) {
    const ids = await realExcept.apply(this, parameters)
    if (isArmed()) {
      revoked()
      await release
    }
    return ids
  }
  return [
    (run) => withMutatedMethod(UserTokenRepository.prototype, 'revokeAllForUser', holdingAll, run),
    (run) =>
      withMutatedMethod(
        UserTokenRepository.prototype,
        'revokeAllForUserExceptSession',
        holdingExcept,
        run
      ),
  ]
}

/**
 * The login's refresh-token rows for `user`.
 * @param user - The user.
 * @returns How many refresh rows exist.
 */
async function refreshRowCount(user: User): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens
    where user_id = ${user.id} and purpose = 'refresh'
  `
  return row?.count ?? 0
}

/**
 * Whether the stored hash now matches `password`.
 * @param user - The user.
 * @param password - The candidate.
 * @returns True when it matches.
 */
async function isStoredPassword(user: User, password: string): Promise<boolean> {
  const [row] = await sql<{ password_hash: string | null }[]>`
    select password_hash from users where id = ${user.id}
  `
  return row?.password_hash ? isPasswordValid(password, row.password_hash) : false
}

describe.each<PasswordFlow>(['change', 'reset'])(
  'password %s against a concurrent login',
  (flow) => {
    /**
     * The login commits first: it takes FOR SHARE and holds it, the password
     * write queues on its row lock, then the login issues its token and commits.
     * @param user - The user both sides act on.
     * @param options - Mutation-proof switches.
     * @param options.revokeBeforeLock - Moves the revoke ahead of the row lock (mutation proof only).
     * @returns Whether the password side waited, and both outcomes.
     */
    async function raceLoginFirst(
      user: User,
      options: { revokeBeforeLock?: boolean } = {}
    ): Promise<{
      passwordWaited: boolean
      login: PromiseSettledResult<LoginResult>
      password: PromiseSettledResult<void>
    }> {
      const writePassword = await preparePasswordWrite(flow, user)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realLockById = UserRepository.prototype.lockById
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realRevokeAll = UserTokenRepository.prototype.revokeAllForUser
      const tokenRepository = new UserTokenRepository()
      const loginLocked = deferred()
      const releaseLogin = deferred()
      const passwordPid = deferred<number>()

      const lockById: typeof realLockById = async function (this: UserRepository, id, mode, tx) {
        if (mode === 'no key update') {
          passwordPid.resolve(await backendPid(tx))
          if (options.revokeBeforeLock) await realRevokeAll.call(tokenRepository, id, tx)
          return realLockById.call(this, id, mode, tx)
        }
        const row = await realLockById.call(this, id, mode, tx)
        loginLocked.resolve()
        await releaseLogin.promise
        return row
      }
      const mutations: Mutation[] = [
        (run) => withMutatedMethod(UserRepository.prototype, 'lockById', lockById, run),
      ]
      if (options.revokeBeforeLock) {
        mutations.push(
          (run) =>
            withMutatedMethod(
              UserTokenRepository.prototype,
              'revokeAllForUser',
              () => Promise.resolve([]),
              run
            ),
          (run) =>
            withMutatedMethod(
              UserTokenRepository.prototype,
              'revokeAllForUserExceptSession',
              () => Promise.resolve([]),
              run
            )
        )
      }

      // A holder object: TypeScript does not see assignments made inside the callback.
      const observed: {
        waited: boolean
        settled?: [PromiseSettledResult<LoginResult>, PromiseSettledResult<void>]
      } = { waited: false }
      await withMutations(mutations, async () => {
        const loggingIn = login({ email: user.email, password: OLD_PASSWORD })
        let writing: Promise<void> | undefined
        try {
          await untilSignalled(loginLocked.promise, loggingIn, 'login')
          writing = writePassword()
          const pid = await untilSignalled(passwordPid.promise, writing, 'the password write')
          observed.waited = await waitForBlocked(pid, writing)
        } finally {
          releaseLogin.resolve()
        }
        observed.settled = await Promise.allSettled([loggingIn, writing ?? Promise.resolve()])
      })
      if (!observed.settled) throw new Error('the race did not run')
      return {
        passwordWaited: observed.waited,
        login: observed.settled[0],
        password: observed.settled[1],
      }
    }

    /**
     * The password write commits first: login compares the old hash and
     * pauses, the password transaction locks, stores and revokes and holds,
     * then login's FOR SHARE queues behind it.
     * @param user - The user both sides act on.
     * @param options - Mutation-proof switches.
     * @param options.unlockedLoginRead - Replaces login's locked re-read with a plain read (mutation proof only).
     * @returns Whether login waited, and both outcomes.
     */
    async function racePasswordFirst(
      user: User,
      options: { unlockedLoginRead?: boolean } = {}
    ): Promise<{
      loginWaited: boolean
      login: PromiseSettledResult<LoginResult>
      password: PromiseSettledResult<void>
    }> {
      const writePassword = await preparePasswordWrite(flow, user)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realUpdate = UserRepository.prototype.update
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realLockById = UserRepository.prototype.lockById
      const loginCompared = deferred()
      const releaseLogin = deferred()
      const passwordRevoked = deferred()
      const releasePassword = deferred()
      const loginPid = deferred<number>()
      // A holder object: TypeScript does not see assignments made inside the callback.
      const flags = { passwordLocked: false }

      const pausingUpdate: typeof realUpdate = async function (
        this: UserRepository,
        ...parameters
      ) {
        const row = await realUpdate.apply(this, parameters)
        if ('lastLoggedInAt' in parameters[1]) {
          loginCompared.resolve()
          await releaseLogin.promise
        }
        return row
      }
      const lockById: typeof realLockById = async function (this: UserRepository, id, mode, tx) {
        if (mode !== 'share') {
          const row = await realLockById.call(this, id, mode, tx)
          flags.passwordLocked = true
          return row
        }
        loginPid.resolve(await backendPid(tx))
        if (options.unlockedLoginRead) return this.findById(id, {}, tx)
        return realLockById.call(this, id, mode, tx)
      }

      // A holder object: TypeScript does not see assignments made inside the callback.
      const observed: {
        waited: boolean
        settled?: [PromiseSettledResult<LoginResult>, PromiseSettledResult<void>]
      } = { waited: false }
      await withMutations(
        [
          (run) => withMutatedMethod(UserRepository.prototype, 'update', pausingUpdate, run),
          (run) => withMutatedMethod(UserRepository.prototype, 'lockById', lockById, run),
          ...holdAfterRevoke(
            () => passwordRevoked.resolve(),
            releasePassword.promise,
            () => flags.passwordLocked
          ),
        ],
        async () => {
          const loggingIn = login({ email: user.email, password: OLD_PASSWORD })
          let writing: Promise<void> | undefined
          try {
            await untilSignalled(loginCompared.promise, loggingIn, 'login')
            writing = writePassword()
            await untilSignalled(passwordRevoked.promise, writing, 'the password write')
            releaseLogin.resolve()
            const pid = await untilSignalled(loginPid.promise, loggingIn, 'login')
            observed.waited = await waitForBlocked(pid, loggingIn)
          } finally {
            releaseLogin.resolve()
            releasePassword.resolve()
          }
          observed.settled = await Promise.allSettled([loggingIn, writing ?? Promise.resolve()])
        }
      )
      if (!observed.settled) throw new Error('the race did not run')
      return {
        loginWaited: observed.waited,
        login: observed.settled[0],
        password: observed.settled[1],
      }
    }

    /**
     * The login committed first, so the password write revoked and denied its session.
     * @param race - The race's result.
     */
    async function expectLoginSessionRevoked(
      race: Awaited<ReturnType<typeof raceLoginFirst>>
    ): Promise<void> {
      expect(race.passwordWaited).toBe(true)
      expect(race.password.status).toBe('fulfilled')
      if (race.login.status !== 'fulfilled') throw race.login.reason
      const session = race.login.value.refreshToken
      // The raw client returns timestamps as strings, so ask Postgres instead.
      const [row] = await sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from user_tokens
      where token_hash = ${hashToken(session.raw)}
    `
      expect(row?.revoked).toBe(true)
      expect(await isSessionDenied(session.sessionId)).toBe(true)
    }

    /**
     * The password write committed first, so login saw the new hash and issued nothing.
     * @param user - The user.
     * @param race - The race's result.
     */
    async function expectLoginRefused(
      user: User,
      race: Awaited<ReturnType<typeof racePasswordFirst>>
    ): Promise<void> {
      expect(race.loginWaited).toBe(true)
      expect(race.password.status).toBe('fulfilled')
      expect(race.login).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 401, message: 'Invalid email or password' },
      })
      expect(await refreshRowCount(user)).toBe(0)
      expect(await isStoredPassword(user, NEW_PASSWORD)).toBe(true)
    }

    it('revokes and denies the session of a login that committed first', async () => {
      const user = await seedUser()
      await expectLoginSessionRevoked(await raceLoginFirst(user))
    })

    it('refuses a login that compared the old hash once the new one has committed', async () => {
      const user = await seedUser()
      await expectLoginRefused(user, await racePasswordFirst(user))
    })

    // DELIBERATELY red under MUTATION_PROOF=1: the revoke runs before the row
    // lock, so the login's token, committed after it, survives.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'reproduces the login-first test with the revoke moved ahead of the row lock',
      async () => {
        const user = await seedUser()
        await expectLoginSessionRevoked(await raceLoginFirst(user, { revokeBeforeLock: true }))
      }
    )

    // DELIBERATELY red under MUTATION_PROOF=1: login re-reads the hash without
    // FOR SHARE, sees the uncommitted write's old value and issues a token.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'reproduces the password-first test with an unlocked login re-read',
      async () => {
        const user = await seedUser()
        await expectLoginRefused(user, await racePasswordFirst(user, { unlockedLoginRead: true }))
      }
    )
  }
)

/**
 * The second login compares and pauses after its lastLoggedInAt UPDATE,
 * which conflicts with FOR SHARE and so must run before the first login
 * locks. The first login then takes FOR SHARE and holds it while the
 * second resumes, re-reads under its own lock, and finishes.
 * @param user - The user both logins act on.
 * @param options - Mutation-proof switches.
 * @param options.exclusiveReRead - Swaps login's FOR SHARE for FOR NO KEY UPDATE (mutation proof only).
 * @returns Whether the second login waited, its outcome while the first was held, and both final outcomes.
 */
async function raceTwoLogins(
  user: User,
  options: { exclusiveReRead?: boolean } = {}
): Promise<{
  secondWaited: boolean
  secondWhileHeld: PromiseSettledResult<LoginResult> | undefined
  first: PromiseSettledResult<LoginResult>
  second: PromiseSettledResult<LoginResult>
}> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realUpdate = UserRepository.prototype.update
  // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
  const realLockById = UserRepository.prototype.lockById
  const secondCompared = deferred()
  const releaseSecond = deferred()
  const firstLocked = deferred()
  const releaseFirst = deferred()
  const secondPid = deferred<number>()
  // A holder object: TypeScript does not see assignments made inside the callback.
  const calls = { update: 0, lockById: 0 }

  const pausingUpdate: typeof realUpdate = async function (this: UserRepository, ...parameters) {
    const row = await realUpdate.apply(this, parameters)
    calls.update += 1
    if (calls.update === 1) {
      secondCompared.resolve()
      await releaseSecond.promise
    }
    return row
  }
  const lockById: typeof realLockById = async function (this: UserRepository, id, mode, tx) {
    const lockMode = options.exclusiveReRead ? 'no key update' : mode
    calls.lockById += 1
    if (calls.lockById === 1) {
      const row = await realLockById.call(this, id, lockMode, tx)
      firstLocked.resolve()
      await releaseFirst.promise
      return row
    }
    secondPid.resolve(await backendPid(tx))
    return realLockById.call(this, id, lockMode, tx)
  }

  // A holder object: TypeScript does not see assignments made inside the callback.
  const observed: {
    waited: boolean
    whileHeld: PromiseSettledResult<LoginResult> | undefined
    settled?: [PromiseSettledResult<LoginResult>, PromiseSettledResult<LoginResult>]
  } = { waited: false, whileHeld: undefined }
  await withMutations(
    [
      (run) => withMutatedMethod(UserRepository.prototype, 'update', pausingUpdate, run),
      (run) => withMutatedMethod(UserRepository.prototype, 'lockById', lockById, run),
    ],
    async () => {
      const second = login({ email: user.email, password: OLD_PASSWORD })
      let first: Promise<LoginResult> | undefined
      try {
        await untilSignalled(secondCompared.promise, second, 'the second login')
        first = login({ email: user.email, password: OLD_PASSWORD })
        await untilSignalled(firstLocked.promise, first, 'the first login')
        releaseSecond.resolve()
        const pid = await untilSignalled(secondPid.promise, second, 'the second login')
        observed.waited = await waitForBlocked(pid, second)
        // Not blocked means it settled, so this does not wait on the held first login.
        if (!observed.waited) {
          const [whileHeld] = await Promise.allSettled([second])
          observed.whileHeld = whileHeld
        }
      } finally {
        releaseSecond.resolve()
        releaseFirst.resolve()
      }
      observed.settled = await Promise.allSettled([
        first ?? Promise.reject(new Error('the first login never started')),
        second,
      ])
    }
  )
  if (!observed.settled) throw new Error('the race did not run')
  return {
    secondWaited: observed.waited,
    secondWhileHeld: observed.whileHeld,
    first: observed.settled[0],
    second: observed.settled[1],
  }
}

/**
 * The second login finished while the first held FOR SHARE, and both kept a session.
 * @param user - The user.
 * @param race - The race's result.
 */
async function expectBothLoggedIn(
  user: User,
  race: Awaited<ReturnType<typeof raceTwoLogins>>
): Promise<void> {
  expect(race.secondWaited).toBe(false)
  expect(race.secondWhileHeld?.status).toBe('fulfilled')
  expect(race.first.status).toBe('fulfilled')
  expect(race.second.status).toBe('fulfilled')
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens
    where user_id = ${user.id} and purpose = 'refresh' and revoked_at is null
  `
  expect(row?.count).toBe(2)
}

describe('two logins at once', () => {
  it('two logins for the same user at once both succeed', async () => {
    const user = await seedUser()
    await expectBothLoggedIn(user, await raceTwoLogins(user))
  })

  // DELIBERATELY red under MUTATION_PROOF=1: an exclusive re-read makes the
  // second login wait for the first.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the two-logins test with an exclusive login re-read',
    async () => {
      const user = await seedUser()
      await expectBothLoggedIn(user, await raceTwoLogins(user, { exclusiveReRead: true }))
    }
  )
})

describe('the denylist write after commit', () => {
  it('keeps a committed change when Redis refuses the denylist write, and logs one error', async () => {
    const user = await seedUser()
    const other = await issueRefreshToken(user.id, randomUUID())
    const client = await getRedis()
    const errorSpy = vi.spyOn(logger, 'error')
    // Only denySession writes with SET during a direct service call.
    const refusingSet = (() =>
      Promise.reject(new Error('simulated Redis outage'))) as unknown as typeof client.set

    await withMutatedMethod(client, 'set', refusingSet, async () => {
      await expect(
        changePassword(user.id, randomUUID(), {
          currentPassword: OLD_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
      ).resolves.toBeUndefined()
    })

    expect(await isStoredPassword(user, NEW_PASSWORD)).toBe(true)
    // The raw client returns timestamps as strings, so ask Postgres instead.
    const [row] = await sql<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from user_tokens
      where token_hash = ${hashToken(other.raw)}
    `
    expect(row?.revoked).toBe(true)
    const failures = errorSpy.mock.calls.filter(([message]) => message === DENYLIST_FAILURE)
    expect(failures).toEqual([[DENYLIST_FAILURE, { userId: user.id, sessionCount: 1 }]])
  })
})
