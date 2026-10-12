/**
 * @file POST /api/v1/auth/verify-email and POST /api/v1/auth/resend-verification
 * against the real per-worker Postgres database; created users are deleted in
 * afterEach. The verify-email tests seed rows through repositories instead of
 * POST /auth/register, so they do not depend on the registration contract.
 *
 * The identical-response test is the security core: a wrong password, an
 * unknown token and a malformed body must give the same body (and a wrong
 * password the same status as an unknown token). A failure that differed would
 * be a token-state oracle.
 */

import { randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { issueToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import {
  assertNoMailpitMessage,
  drainMailpit,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const REFRESH_TOKEN_COOKIE_NAME = testRefreshCookie().name

// A verification mail is queued through addNotificationJob and reaches the email queue only after the notification worker fans it out; the registration-attempt notice goes straight to the email queue. Mail assertions therefore need both workers.
const worker: Worker<EmailJobData> = startEmailWorker()
const notificationWorker = startNotificationWorker()

afterAll(async () => {
  await worker.close()
  await notificationWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * POSTs a raw verification token and a password to /api/v1/auth/verify-email.
 */
async function verify(token: string, password: string): Promise<Response> {
  return request(app).post('/api/v1/auth/verify-email').send({ token, password })
}

/**
 * Seeds an unverified user with a hashed password and a live
 * email_verification token, returning the raw token.
 */
async function seedUnverifiedUser(): Promise<{ user: { id: string }; token: string }> {
  const user = await userRepository.create({
    email: `verify-${randomUUID()}@example.com`,
    passwordHash: await hashPassword(VALID_PASSWORD),
  })
  createdIds.push(user.id)

  const issued = await issueToken(user.id, 'email_verification', 60_000)
  return { user, token: issued.raw }
}

const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

describe('POST /api/v1/auth/verify-email', () => {
  it('verifies with a valid token and the account password', async () => {
    const { user, token } = await seedUnverifiedUser()

    const response = await verify(token, VALID_PASSWORD)

    expect(response.status).toBe(200)
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        message: 'Email verified.',
        statusCode: 200,
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
        data: null,
      })
    )
    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date)
  })

  it('answers identically for a wrong password, an unknown token, and a malformed body', async () => {
    const { token } = await seedUnverifiedUser()
    const fixedRequestId = randomUUID()

    const wrongPassword = await request(app)
      .post('/api/v1/auth/verify-email')
      .set('X-Request-Id', fixedRequestId)
      .send({ token, password: 'not-the-right-password' })

    const unknownToken = await request(app)
      .post('/api/v1/auth/verify-email')
      .set('X-Request-Id', fixedRequestId)
      .send({ token: 'deadbeef', password: VALID_PASSWORD })

    // No password field: without the try/catch around parseBody in the controller this would answer "Validation failed" with fieldErrors, and the assertion below would fail.
    const malformed = await request(app)
      .post('/api/v1/auth/verify-email')
      .set('X-Request-Id', fixedRequestId)
      .send({ token })

    expect(malformed.body).toEqual(unknownToken.body)

    // Direct equality, not "both are 4xx": a wrong-password answer that differed from an unknown token's would show that the token is live and that the address already has a password someone set, which tells a link holder it is squatted.
    expect(wrongPassword.body).toEqual(unknownToken.body)
    expect(wrongPassword.status).toBe(unknownToken.status)
    expect(wrongPassword.status).toBe(400)
  })

  it('burns the token on a wrong password', async () => {
    const { token } = await seedUnverifiedUser()
    await verify(token, 'not-the-right-password')

    // By design (SECURITY.md): one link is one attempt, so a leaked link gives an attacker exactly one password guess.
    const retried = await verify(token, VALID_PASSWORD)
    expect(retried.status).toBe(400)
  })

  it('answers a second click on a used link with 409 already verified, and never applies its password', async () => {
    const { user, token } = await seedUnverifiedUser()
    const first = await verify(token, VALID_PASSWORD)
    expect(first.status).toBe(200)
    const before = await userRepository.findById(user.id)

    const second = await verify(token, 'a different password entirely')

    expect(second.status).toBe(409)
    expect(second.body).toEqual(
      expect.objectContaining({
        success: false,
        code: 'email_already_verified',
        message: 'This email is already verified. Sign in to continue.',
      })
    )
    const after = await userRepository.findById(user.id)
    expect(after?.passwordHash).toBe(before?.passwordHash)
    expect(after?.emailVerifiedAt?.getTime()).toBe(before?.emailVerifiedAt?.getTime())
  })

  it('answers a used link 400 while its account is still unverified', async () => {
    const { token } = await seedUnverifiedUser()
    await verify(token, 'not-the-right-password')

    const second = await verify(token, VALID_PASSWORD)

    expect(second.status).toBe(400)
    expect(second.body).toEqual(
      expect.objectContaining({ message: 'Invalid or expired verification token.' })
    )
  })

  it('answers an expired link 400 even when its account is verified', async () => {
    const { user } = await seedUnverifiedUser()
    const expired = await issueToken(user.id, 'email_verification', -1000)
    await sql`update users set email_verified_at = now() where id = ${user.id}`

    const response = await verify(expired.raw, VALID_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('answers a used password_reset token 400 even when its account is verified', async () => {
    const { user } = await seedUnverifiedUser()
    const reset = await issueToken(user.id, 'password_reset', 60_000)
    await sql`update user_tokens set revoked_at = now(), consumed_at = now() where user_id = ${user.id} and purpose = 'password_reset'`
    await sql`update users set email_verified_at = now() where id = ${user.id}`

    const response = await verify(reset.raw, VALID_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('answers an unknown token 400 with the old message', async () => {
    const response = await verify('deadbeef', VALID_PASSWORD)

    expect(response.status).toBe(400)
    expect(response.body).toEqual(
      expect.objectContaining({ message: 'Invalid or expired verification token.' })
    )
  })

  it('refuses a password_reset token', async () => {
    const { user } = await seedUnverifiedUser()
    const reset = await issueToken(user.id, 'password_reset', 60_000)

    const response = await verify(reset.raw, VALID_PASSWORD)
    expect(response.status).toBe(400)
  })

  it('refuses an expired token', async () => {
    const { user } = await seedUnverifiedUser()
    const expired = await issueToken(user.id, 'email_verification', -1000)

    const response = await verify(expired.raw, VALID_PASSWORD)
    expect(response.status).toBe(400)
  })

  it('succeeds and leaves the original timestamp when already verified', async () => {
    const { user, token } = await seedUnverifiedUser()
    await verify(token, VALID_PASSWORD)
    const first = await userRepository.findById(user.id)
    const second = await issueToken(user.id, 'email_verification', 60_000)

    const response = await verify(second.raw, VALID_PASSWORD)

    // markEmailVerified returns undefined for an already-verified account, and that is success: answering 400 would make a second valid link an error.
    expect(response.status).toBe(200)
    const after = await userRepository.findById(user.id)
    expect(after?.emailVerifiedAt?.getTime()).toBe(first?.emailVerifiedAt?.getTime())
  })

  it('revokes the user other outstanding verification links', async () => {
    const { user, token } = await seedUnverifiedUser()
    const alsoLive = await issueToken(user.id, 'email_verification', 60_000)

    await verify(token, VALID_PASSWORD)

    const response = await verify(alsoLive.raw, VALID_PASSWORD)
    expect(response.status).toBe(400)
  })

  it('does not verify the account when the password is wrong', async () => {
    const { user, token } = await seedUnverifiedUser()

    await verify(token, 'not-the-right-password')

    // A status code cannot show whether the column was written.
    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeNull()
  })
})

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold or with another address's rate-limit
 * counters.
 */
function uniqueEmail(): string {
  return `resend-verification-${randomUUID()}@example.test`
}

/**
 * POSTs an address to /api/v1/auth/resend-verification.
 */
async function resend(email: string): Promise<Response> {
  return request(app).post('/api/v1/auth/resend-verification').send({ email })
}

/**
 * Registers a user through the real HTTP endpoint and tracks the unverified
 * row for deletion in afterEach.
 */
async function registerUser(
  overrides: Partial<{ email: string; password: string }> = {}
): Promise<{ email: string; user: User }> {
  const email = overrides.email ?? uniqueEmail()
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: VALID_PASSWORD, ...overrides })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`registerUser: no user for ${email}`)
  createdIds.push(user.id)
  return { email, user }
}

/**
 * Registers a user and marks them verified in SQL, so a test gets a usable
 * account without walking the verification flow or weakening resendVerification's guard.
 */
async function registerVerifiedUser(
  overrides: Partial<{ email: string; password: string }> = {}
): Promise<{ email: string; user: User }> {
  const { email, user } = await registerUser(overrides)
  await sql`update users set email_verified_at = now() where id = ${user.id}`
  const verified = await userRepository.findById(user.id)
  if (!verified) throw new Error(`registerVerifiedUser: user vanished for ${email}`)
  return { email, user: verified }
}

/**
 * Registers a fresh user, marks them verified and logs in over HTTP, pushing
 * the user's id onto `createdIds` for afterEach cleanup.
 */
async function registerAndLogin(
  createdIds: string[]
): Promise<{ response: Response; email: string; user: User }> {
  const email = uniqueEmail()
  await request(app).post('/api/v1/auth/register').send({ email, password: VALID_PASSWORD })
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`registerAndLogin: no user for ${email}`)
  createdIds.push(user.id)
  await sql`update users set email_verified_at = now() where id = ${user.id}`

  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: VALID_PASSWORD })
  return { response, email, user }
}

/**
 * The refresh-token cookie's `name=value` pair from a response's `Set-Cookie`
 * header, or undefined when the cookie was not set.
 */
function refreshCookiePair(response: Response): string | undefined {
  const cookieLines = response.headers['set-cookie'] as string[] | undefined
  const line = cookieLines?.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
  return line?.split(';', 1)[0]
}

const RESEND_VERIFICATION_IP_KEY_PATTERN = `${redisKey('rl', 'resend-verification-ip')}:*`
const RESEND_VERIFICATION_EMAIL_KEY_PATTERN = `${redisKey('rl', 'resend-verification-email')}:*`

/**
 * Every Redis key matching a glob pattern, found with SCAN rather than KEYS,
 * which blocks the server for the whole keyspace and this may be a
 * developer's own Redis with other data in it; the same choice as
 * `clearRateLimitCounters` in global-setup.ts.
 */
async function redisKeysMatching(pattern: string): Promise<string[]> {
  const client = await getRedis()
  const found: string[] = []
  const batches = client.scanIterator({ MATCH: pattern, COUNT: 100 })
  for await (const keys of batches) {
    found.push(...keys)
  }
  return found
}

/**
 * Clears the resend-verification IP limiter's counter before each test. The
 * limiter allows 5 an hour and is keyed on IP alone, so every request from
 * this suite's one client address shares one bucket whatever the submitted
 * address. Redis is cleared only once per run, in global setup
 * (tests/helpers/global-setup.ts), so without this the sixth call in this
 * describe block would answer 429 instead of 202, and the failing assertion
 * would often be several tests away from the one that spent the budget.
 */
async function clearResendVerificationIpLimiter(): Promise<void> {
  const client = await getRedis()
  const keys = await redisKeysMatching(RESEND_VERIFICATION_IP_KEY_PATTERN)
  if (keys.length > 0) await client.del(keys)
}

const RESEND_BODY = {
  success: true,
  message: 'If that address needs verification, a new link has been sent.',
  statusCode: 202,
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
  data: null,
}

describe('POST /api/v1/auth/resend-verification', () => {
  // createdIds and afterEach are module-level; registerUser and registerVerifiedUser close over them.
  beforeEach(clearResendVerificationIpLimiter)

  it('answers identically for unknown, unverified and already-verified addresses', async () => {
    const { email: unverified } = await registerUser()
    const { email: verified } = await registerVerifiedUser()

    const responses = await Promise.all(
      [uniqueEmail(), unverified, verified].map((email) => resend(email))
    )

    for (const response of responses) {
      expect(response.status).toBe(202)
      expect(response.body).toEqual(RESEND_BODY)
    }
  })

  it('answers a malformed address identically', async () => {
    const response = await resend('not-an-address')

    expect(response.status).toBe(202)
    expect(response.body).toEqual(RESEND_BODY)
  })

  // The positive check runs first, so the negative checks start only after the mail has landed and give an errant send time to arrive.
  it('mails only the unverified address', async () => {
    const unknown = uniqueEmail()
    const { email: unverified } = await registerUser()
    const { email: verified } = await registerVerifiedUser()
    await drainMailpit(unverified)
    await drainMailpit(verified)

    for (const email of [unknown, unverified, verified]) {
      await resend(email)
    }

    expect(await findMailpitMessages(unverified)).toHaveLength(1)
    await assertNoMailpitMessage(unknown)
    await assertNoMailpitMessage(verified)
  })

  // resendVerificationMail revokes before it sends, and the 202 response does not wait for either, so the mail's arrival shows the revoke has run.
  it('invalidates the previous link when a new one is sent, and the new one verifies', async () => {
    const { email, user } = await registerUser()
    const first = await issueToken(user.id, 'email_verification', 60_000)
    await drainMailpit(email)

    await resend(email)

    const messages = await findMailpitMessages(email)
    expect(messages).toHaveLength(1)
    const detail = await getMailpitMessage(messages[0]?.ID ?? '')
    const secondToken = /token=([0-9a-f]+)/.exec(detail.Text)?.[1]
    expect(secondToken).toBeDefined()

    // Two live links would let a token read out of an older mail keep working after a re-request.
    const oldAttempt = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: first.raw, password: VALID_PASSWORD })
    expect(oldAttempt.status).toBe(400)

    // The new link must work too: sending before revoking would revoke the new token along with the old, and only this assertion catches that.
    const newAttempt = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: secondToken ?? '', password: VALID_PASSWORD })
    expect(newAttempt.status).toBe(200)
  })

  // revokeAllForUser matches on userId alone, so using it here would log the user out of every device.
  it('leaves a live refresh token alone when it clears old links', async () => {
    const { response: login, email, user } = await registerAndLogin(createdIds)
    await sql`update users set email_verified_at = null where id = ${user.id}`
    await drainMailpit(email)

    await resend(email)

    // The mail's arrival shows the revoke has run; checking the refresh token earlier would prove nothing.
    expect(await findMailpitMessages(email)).toHaveLength(1)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookiePair(login) as string)
    expect(refreshed.status).toBe(200)
  })

  // RateLimit-* headers cannot show this: the second limiter's headers overwrite the first's, so only the store shows both limiters counted.
  it('runs both limiters — proven by counters incrementing under both prefixes', async () => {
    const email = uniqueEmail()

    await resend(email)

    const ipKeys = await redisKeysMatching(RESEND_VERIFICATION_IP_KEY_PATTERN)
    const emailKeys = await redisKeysMatching(RESEND_VERIFICATION_EMAIL_KEY_PATTERN)
    expect(ipKeys.length).toBeGreaterThan(0)
    expect(emailKeys.length).toBeGreaterThan(0)
  })
})
