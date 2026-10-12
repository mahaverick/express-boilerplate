/**
 * @file Proves that post-reply mail work and a guarded platform-role read
 * in `auth.service.ts` swallow and log their own failures instead of
 * crashing the process, and never leak a failed query's bound parameters
 * into the log.
 */
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcrypt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { BCRYPT_COST } from '@/constants/auth.constants'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { login, register, requestPasswordReset } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { addressDigest } from '@/services/mail-cooldown.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { prepareResendVerification } from '@/services/verification.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { withMutatedMethod } from '../../helpers/mutate'
import { fakeQueryError, LEAKED_PARAM, loggedText } from '../../helpers/query-error'

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * Returns an address no other test row shares, for a user the test creates.
 */
function uniqueEmail(): string {
  return `auth-service-${randomUUID()}@example.test`
}

/**
 * Stands in for a repository method whose query fails with an error carrying `LEAKED_PARAM`.
 */
function failingQuery(): Promise<never> {
  return Promise.reject(fakeQueryError())
}

/**
 * The controller starts `register`'s follow-up mail,
 * `requestPasswordReset` and the resend-verification mail with a bare
 * `void` after replying, so each must swallow and log its own failure: a
 * rejection there would be unhandled and exit the process. `login`'s
 * platform-role read is guarded the same way: a failed read answers null
 * instead of failing the sign-in. Faults are injected with
 * `withMutatedMethod`; nothing under `src/` is edited. Each test also
 * asserts the failure was logged, so a fault that never reached the work
 * cannot pass vacuously, and that the log carries none of the failed
 * query's bound parameters.
 */
describe('post-reply work never rejects', () => {
  const createdEmails: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    if (createdEmails.length === 0) return
    await sql`delete from users where lower(email) = any(${createdEmails.map((email) => email.toLowerCase())})`
    createdEmails.length = 0
  })

  it("register's follow-up for a free address resolves even when issuing the token fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    const sendFollowUpMail = await register({ email, password: VALID_PASSWORD, app: 'web' })
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserTokenRepository.prototype, 'create', failingQuery, async () => {
      await expect(sendFollowUpMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Verification mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it("register's follow-up for a taken address resolves even when the lookup fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD, app: 'web' })
    const sendFollowUpMail = await register({ email, password: VALID_PASSWORD, app: 'web' })
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', failingQuery, async () => {
      await expect(sendFollowUpMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Registration-attempt mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it('requestPasswordReset resolves even when the lookup fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', failingQuery, async () => {
      await expect(requestPasswordReset(uniqueEmail())).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Forgot-password mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it("prepareResendVerification's mail resolves even when issuing the token fails", async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD, app: 'web' })
    const sendMail = await prepareResendVerification(email)
    const errorSpy = vi.spyOn(logger, 'error')

    await withMutatedMethod(UserTokenRepository.prototype, 'create', failingQuery, async () => {
      await expect(sendMail()).resolves.toBeUndefined()
    })
    expect(errorSpy).toHaveBeenCalledWith('Resend verification mail failed', expect.anything())
    expect(loggedText(errorSpy)).not.toContain(LEAKED_PARAM)
  })

  it('login answers a null platform role, and logs the failed read without its parameters', async () => {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD, app: 'web' })
    await sql`update users set email_verified_at = now() where lower(email) = ${email.toLowerCase()}`
    const warnSpy = vi.spyOn(logger, 'warn')

    let platformRole: unknown
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'findPlatformRole',
      failingQuery,
      async () => {
        ;({ platformRole } = await login({ email, password: VALID_PASSWORD }))
      }
    )

    expect(platformRole).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      'Platform role could not be read for the login response',
      expect.anything()
    )
    expect(loggedText(warnSpy)).not.toContain(LEAKED_PARAM)
  })
})

/**
 * Counts the password-reset tokens a user was issued: one per queued reset mail.
 */
async function resetTokenCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens
    where user_id = ${userId} and purpose = 'password_reset'
  `
  return row?.count ?? 0
}

/**
 * Forgot-password answers every request 202 and has no per-address limiter:
 * anyone who knows an address could spend its budget and deny the owner their
 * mail. One reset mail per address per `PASSWORD_RESET_MAIL_COOLDOWN` bounds
 * the inbox instead.
 */
describe('requestPasswordReset mail cooldown', () => {
  const userRepository = new UserRepository()
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Creates a verified account, deleted in `afterEach`, to request resets for.
   */
  async function seedActiveUser(): Promise<{ id: string; email: string }> {
    const user = await userRepository.create({ email: uniqueEmail(), emailVerifiedAt: new Date() })
    createdIds.push(user.id)
    return { id: user.id, email: user.email }
  }

  it('queues one reset mail for twenty requests inside the cooldown', async () => {
    const { id, email } = await seedActiveUser()

    for (let index = 0; index < 20; index += 1) {
      await requestPasswordReset(email)
    }

    expect(await resetTokenCount(id)).toBe(1)
  })

  // The cooldown is a Redis key with a PX expiry; deleting it is what that expiry does, with no wall-clock wait.
  it("queues the owner's request once the cooldown has passed", async () => {
    const { id, email } = await seedActiveUser()
    for (let index = 0; index < 20; index += 1) {
      await requestPasswordReset(email)
    }
    expect(await resetTokenCount(id)).toBe(1)

    const key = redisKey('password-reset-notice', addressDigest(email))
    const redis = await getRedis()
    const remainingMs = await redis.pTTL(key)
    expect(remainingMs).toBeGreaterThan(0)
    expect(remainingMs).toBeLessThanOrEqual(
      requireDurationMs(getEnv().PASSWORD_RESET_MAIL_COOLDOWN)
    )

    await redis.del(key)
    await requestPasswordReset(email)

    expect(await resetTokenCount(id)).toBe(2)
  })

  it('keeps one address in cooldown from holding back another', async () => {
    const first = await seedActiveUser()
    const second = await seedActiveUser()

    await requestPasswordReset(first.email)
    await requestPasswordReset(second.email)

    expect(await resetTokenCount(first.id)).toBe(1)
    expect(await resetTokenCount(second.id)).toBe(1)
  })
})

/**
 * The password hash stored for an address.
 */
async function storedHash(email: string): Promise<string> {
  const [row] = await sql<{ passwordHash: string }[]>`
    select password_hash as "passwordHash" from users where lower(email) = ${email.toLowerCase()}
  `
  if (!row) throw new Error('user not found')
  return row.passwordHash
}

/**
 * A successful login rewrites a hash made at a lower cost than `BCRYPT_COST`,
 * leaves a current-cost hash alone, and never fails or changes its answer
 * because of the rewrite.
 */
describe('login rehashes an old-cost password hash', () => {
  const OLD_COST = 4
  const createdEmails: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    if (createdEmails.length === 0) return
    await sql`delete from users where lower(email) = any(${createdEmails.map((email) => email.toLowerCase())})`
    createdEmails.length = 0
  })

  /**
   * Register a verified user, optionally with its hash replaced by one at `cost`.
   * @param cost - The cost to store the hash at; omitted keeps the hash register wrote.
   * @returns The user's email and the hash now stored.
   */
  async function verifiedUser(cost?: number): Promise<{ email: string; hash: string }> {
    const email = uniqueEmail()
    createdEmails.push(email)
    await register({ email, password: VALID_PASSWORD, app: 'web' })
    await sql`update users set email_verified_at = now() where lower(email) = ${email.toLowerCase()}`
    if (cost !== undefined) {
      const oldHash = await bcrypt.hash(VALID_PASSWORD, cost)
      await sql`update users set password_hash = ${oldHash} where lower(email) = ${email.toLowerCase()}`
    }
    return { email, hash: await storedHash(email) }
  }

  it('rewrites an old-cost hash at BCRYPT_COST on a successful login', async () => {
    const { email, hash } = await verifiedUser(OLD_COST)
    expect(bcrypt.getRounds(hash)).toBe(OLD_COST)

    await login({ email, password: VALID_PASSWORD })

    const rewritten = await storedHash(email)
    expect(bcrypt.getRounds(rewritten)).toBe(BCRYPT_COST)
    expect(await bcrypt.compare(VALID_PASSWORD, rewritten)).toBe(true)
  })

  // B read the row before A's rehash committed; B's locked re-read then sees A's new hash of the same password.
  it('signs in a login whose first read predates a concurrent login’s rehash', async () => {
    const { email } = await verifiedUser(OLD_COST)
    const staleRow = await new UserRepository().findByEmail(email)
    if (!staleRow) throw new Error('user not found')
    await login({ email, password: VALID_PASSWORD })
    expect(bcrypt.getRounds(await storedHash(email))).toBe(BCRYPT_COST)

    await withMutatedMethod(
      UserRepository.prototype,
      'findByEmail',
      () => Promise.resolve(staleRow),
      async () => {
        const result = await login({ email, password: VALID_PASSWORD })
        expect(result.accessToken).toEqual(expect.any(String))
      }
    )
  })

  it('still answers 401 when the hash changed to a different password after the first read', async () => {
    const { email } = await verifiedUser(OLD_COST)
    const staleRow = await new UserRepository().findByEmail(email)
    if (!staleRow) throw new Error('user not found')
    const otherHash = await bcrypt.hash('a different password entirely', OLD_COST)
    await sql`update users set password_hash = ${otherHash} where lower(email) = ${email.toLowerCase()}`

    await withMutatedMethod(
      UserRepository.prototype,
      'findByEmail',
      () => Promise.resolve(staleRow),
      async () => {
        await expect(login({ email, password: VALID_PASSWORD })).rejects.toMatchObject({
          statusCode: 401,
        })
      }
    )
    expect(await storedHash(email)).toBe(otherHash)
  })

  it('leaves a current-cost hash unchanged', async () => {
    const { email, hash } = await verifiedUser()
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST)

    await login({ email, password: VALID_PASSWORD })

    expect(await storedHash(email)).toBe(hash)
  })

  it('leaves an old-cost hash unchanged when the password is wrong', async () => {
    const { email, hash } = await verifiedUser(OLD_COST)

    await expect(login({ email, password: 'not the password' })).rejects.toMatchObject({
      statusCode: 401,
    })

    expect(await storedHash(email)).toBe(hash)
  })

  it('still signs the user in, and logs a warning, when the rewrite fails', async () => {
    const { email, hash } = await verifiedUser(OLD_COST)
    const warnSpy = vi.spyOn(logger, 'warn')

    await withMutatedMethod(
      UserRepository.prototype,
      'replacePasswordHash',
      failingQuery,
      async () => {
        const result = await login({ email, password: VALID_PASSWORD })
        expect(result.accessToken).toEqual(expect.any(String))
      }
    )

    expect(warnSpy).toHaveBeenCalledWith('Password rehash on login failed', expect.anything())
    expect(loggedText(warnSpy)).not.toContain(LEAKED_PARAM)
    expect(await storedHash(email)).toBe(hash)
  })
})
