// tests/integration/api/forgot-password.test.ts
//
// Integration tests for POST /api/v1/auth/forgot-password and
// POST /api/v1/auth/reset-password, against the real per-worker Postgres
// database and the real compose Redis — same conventions as
// tests/integration/api/auth.test.ts and
// tests/integration/api/verification.test.ts: every email used here is
// unique to this run, every row created is deleted in afterEach, and both
// the "email" and "notification" BullMQ workers run for the whole file so
// forgotPassword's `addNotificationJob` call actually reaches Mailpit (see
// those two files' own comments for why both workers, not just one, are
// required).
import { randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import { findOrCreateByGoogle } from '@/controllers/auth.controller'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'
import { hashPassword } from '@/utilities/password.utilities'
import { issueToken } from '@/utilities/token.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import {
  assertNoMailpitMessage,
  deleteMailpitMessage,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * A Google profile claiming an address Google has not verified: the squatter's identity.
 * @param id - Google's stable profile id.
 * @param email - The address the squatter claims.
 * @returns A fixture shaped like what `passthroughGoogleProfile` hands `findOrCreateByGoogle`.
 */
function unverifiedGoogleProfile(id: string, email: string): GoogleProfile {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    provider: 'google',
    id,
    displayName: 'Squatter',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: false }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      email,
      email_verified: false,
    },
  }
}

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
const NEW_PASSWORD = 'a brand new secret passphrase'

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database, or the shared Redis
 * rate-limit counters, may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `forgot-password-${randomUUID()}@example.test`
}

/**
 * The envelope every controller response is wrapped in
 * (response.utilities.ts), narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
}

/**
 * Cast a supertest response's body to a known envelope shape.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * POST to /api/v1/auth/forgot-password with the given address.
 * @param email - The address to submit.
 * @returns The supertest response.
 */
async function forgotPassword(email: string): Promise<Response> {
  return request(app).post('/api/v1/auth/forgot-password').send({ email })
}

/**
 * POST to /api/v1/auth/reset-password with the given token and password.
 * @param token - The raw reset token.
 * @param password - The new password to set.
 * @returns The supertest response.
 */
async function resetPassword(token: string, password: string): Promise<Response> {
  return request(app).post('/api/v1/auth/reset-password').send({ token, password })
}

/**
 * Log in through the real HTTP endpoint.
 * @param email - The email to log in with.
 * @param password - The password to log in with.
 * @returns The supertest response.
 */
async function login(email: string, password: string): Promise<Response> {
  return request(app).post('/api/v1/auth/login').send({ email, password })
}

/**
 * The exact `name=value` pair for the refresh-token cookie out of a
 * response's raw `Set-Cookie` header. Own copy of
 * auth-refresh.test.ts's/verification.test.ts's helper of the same name —
 * each integration file keeps its own rather than sharing one.
 * @param response - The supertest response.
 * @returns The `refreshToken=...` pair, or undefined if the cookie was not set.
 */
function refreshCookiePair(response: Response): string | undefined {
  const cookieLines = response.headers['set-cookie'] as string[] | undefined
  const line = cookieLines?.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
  return line?.split(';', 1)[0]
}

/**
 * Issue a raw `password_reset` token for a user directly through the token
 * utility, bypassing the mailed flow — fast, and independent of the
 * forgot-password controller's own contract for every test that only needs
 * a live token to act on.
 * @param userId - The user the token belongs to.
 * @param ttlMs - How long the token is valid for, in milliseconds. Defaults to 60s; pass a negative value to seed an already-expired token.
 * @returns The raw token.
 */
async function seedResetToken(userId: string, ttlMs = 60_000): Promise<string> {
  const issued = await issueToken(userId, 'password_reset', ttlMs)
  return issued.raw
}

const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

/**
 * Seed a user directly through the repository, with a hashed password and
 * (by default) already verified — mirrors auth.test.ts's
 * `registerVerifiedUser` in spirit, built from repository calls rather than
 * through `POST /auth/register` so this file does not depend on that
 * endpoint's own contract.
 * @param isVerified - Whether to mark the seeded user's email verified. Defaults to true.
 * @returns The created (and re-read) user row and the email used.
 */
async function seedUser(isVerified = true): Promise<{ user: User; email: string }> {
  const email = uniqueEmail()
  const created = await userRepository.create({
    email,
    passwordHash: await hashPassword(VALID_PASSWORD),
  })
  createdIds.push(created.id)
  if (isVerified) {
    await sql`update users set email_verified_at = now() where id = ${created.id}`
  }
  const user = await userRepository.findById(created.id)
  if (!user) throw new Error(`seedUser: user vanished for ${email}`)
  return { user, email }
}

/**
 * Every Redis key matching a pattern, via SCAN rather than KEYS — same
 * choice, and same reason, as verification.test.ts's own copy of this
 * helper (KEYS blocks the whole server).
 * @param pattern - The glob pattern to match.
 * @returns Every matching key.
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
 * Clear every key matching a rate-limiter's own store prefix.
 * @param pattern - The glob pattern identifying one limiter's keys.
 */
async function clearRateLimiterKeys(pattern: string): Promise<void> {
  const client = await getRedis()
  const keys = await redisKeysMatching(pattern)
  if (keys.length > 0) await client.del(keys)
}

// Both forgot-password's IP limiter (5/hour, tight — rate-limit.middleware.ts)
// and reset-password's IP limiter (10/15min) are keyed on IP ALONE, and this
// suite's every request shares one client address. Without clearing before
// every test, a test several places away from the one that actually spends
// either budget is the one that goes red — the same reasoning
// verification.test.ts's own `clearResendVerificationIpLimiter` documents.
// The email-keyed forgot-password limiter needs no clearing: every test uses
// a fresh, unique address (`uniqueEmail`), so it never shares a bucket with
// another test regardless.
beforeEach(async () => {
  await clearRateLimiterKeys('rl:forgot-password-ip:*')
  await clearRateLimiterKeys('rl:reset-password:*')
})

const FORGOT_PASSWORD_RESPONSE_BODY = {
  success: true,
  message: 'If that address has an account, a password reset email has been sent.',
  statusCode: 202,
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
  data: null,
}

describe('POST /api/v1/auth/forgot-password', () => {
  it('returns 202 for a registered address', async () => {
    const { email } = await seedUser()

    const response = await forgotPassword(email)

    expect(response.status).toBe(202)
    expect(response.body).toEqual(FORGOT_PASSWORD_RESPONSE_BODY)
  })

  it('answers a registered address and an unknown one identically', async () => {
    const { email } = await seedUser()

    const registered = await forgotPassword(email)
    const unknown = await forgotPassword(uniqueEmail())

    // Direct equality, not "both are 2xx" — the whole point of Ruling G.
    expect(registered.status).toBe(unknown.status)
    expect(registered.body).toEqual(unknown.body)
    expect(registered.status).toBe(202)
    expect(registered.body).toEqual(FORGOT_PASSWORD_RESPONSE_BODY)
  })

  it('mails a password-reset link to a registered address', async () => {
    const { email } = await seedUser()

    await forgotPassword(email)

    const messages = await findMailpitMessages(email)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toContain('Reset your')
    const detail = await getMailpitMessage(messages[0]?.ID ?? '')
    expect(detail.Text).toContain('/reset-password?token=')
    await deleteMailpitMessage(messages[0]?.ID ?? '')

    // Proves the send routed through addNotificationJob (which inserts the
    // in-app row before enqueuing the paired email — notification.worker.ts's
    // own header comment), not addEmailJob called directly.
    const user = await userRepository.findByEmail(email)
    if (!user) throw new Error('mails a password-reset link: no stored row')
    const notifications = await sql`
      select * from notifications where user_id = ${user.id} and type = 'password_reset_requested'
    `
    expect(notifications).toHaveLength(1)
  })

  it('does not mail an unknown address', async () => {
    const email = uniqueEmail()

    await forgotPassword(email)

    await assertNoMailpitMessage(email)
  })

  it('rate limits after the configured number of attempts (IP-keyed)', async () => {
    // The production IP limiter allows 5 attempts per hour
    // (rate-limit.middleware.ts). Unknown addresses throughout: a registered
    // one would also mail on every one of the first 5 attempts, which this
    // test has no need to drain.
    for (let index = 0; index < 5; index += 1) {
      const response = await forgotPassword(uniqueEmail())
      expect(response.status).toBe(202)
    }
    const limited = await forgotPassword(uniqueEmail())

    expect(limited.status).toBe(429)
    expect(limited.headers).toHaveProperty('ratelimit-limit')
  })

  it('runs both forgot-password limiters — proven by counters incrementing under both prefixes', async () => {
    // Same reasoning as verification.test.ts's identical test for
    // resend-verification: RateLimit-* headers alone only ever prove the
    // LAST limiter in the chain ran, so reading the store directly is the
    // only way to prove both fired.
    await forgotPassword(uniqueEmail())

    const ipKeys = await redisKeysMatching('rl:forgot-password-ip:*')
    const emailKeys = await redisKeysMatching('rl:forgot-password-email:*')
    expect(ipKeys.length).toBeGreaterThan(0)
    expect(emailKeys.length).toBeGreaterThan(0)
  })
})

describe('POST /api/v1/auth/reset-password', () => {
  it('resets the password with a valid token', async () => {
    const { user } = await seedUser()
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, NEW_PASSWORD)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: 'Password has been reset.',
      statusCode: 200,
      // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
      data: null,
    })
  })

  // The path a user takes the moment they believe they are compromised:
  // reset the password to end every session. Before this task,
  // resetPassword (via revokeAllSessions -> revokeAllForUser) revoked
  // every refresh-token row — no new refresh was possible — but denied
  // zero access tokens, so an attacker holding a stolen access token could
  // keep using it for the rest of ACCESS_TOKEN_TTL (15 minutes) even after
  // the legitimate user "fixed" things. This is the test that would have
  // caught that gap.
  it('refuses an access token issued before the reset, once the reset completes', async () => {
    const { user, email } = await seedUser()

    // The real login flow, not a fabricated session id: the denylist
    // denies by PRESENCE, so a token carrying an unknown sid would never
    // be denied and this assertion would pass vacuously.
    const loginResponse = await login(email, VALID_PASSWORD)
    const accessToken = envelopeOf<{ accessToken: string }>(loginResponse).data?.accessToken
    expect(accessToken).toBeDefined()

    const beforeReset = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${accessToken as string}`)
    expect(beforeReset.status).toBe(200)

    const resetToken = await seedResetToken(user.id)
    const resetResponse = await resetPassword(resetToken, NEW_PASSWORD)
    expect(resetResponse.status).toBe(200)

    // THE WHOLE POINT: the same access token, which has NOT expired, is
    // now refused.
    const afterReset = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${accessToken as string}`)
    expect(afterReset.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const { user } = await seedUser()
    const token = await seedResetToken(user.id, -1000)

    const response = await resetPassword(token, NEW_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('rejects an unknown token', async () => {
    const response = await resetPassword('a'.repeat(64), NEW_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('refuses the same token twice — single-use', async () => {
    const { user } = await seedUser()
    const token = await seedResetToken(user.id)

    const first = await resetPassword(token, NEW_PASSWORD)
    expect(first.status).toBe(200)

    const second = await resetPassword(token, 'some-other-new-password-1234')
    expect(second.status).toBe(400)
  })

  it('kills a second outstanding reset link once the first succeeds', async () => {
    // revokeAllSessions (revokeAllForUser, user-token.repository.ts) has no
    // purpose predicate — a successful reset revokes every live token this
    // user holds, including any OTHER still-outstanding password_reset link
    // from an earlier request, not only the one just claimed.
    const { user } = await seedUser()
    const first = await seedResetToken(user.id)
    const second = await seedResetToken(user.id)

    const firstResponse = await resetPassword(first, NEW_PASSWORD)
    expect(firstResponse.status).toBe(200)

    const secondResponse = await resetPassword(second, 'yet-another-new-password-1234')
    expect(secondResponse.status).toBe(400)
  })

  it('sets emailVerifiedAt for a previously unverified user', async () => {
    const { user } = await seedUser(false)
    expect(user.emailVerifiedAt).toBeNull()
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, NEW_PASSWORD)

    expect(response.status).toBe(200)
    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date)
  })

  it('does not move an existing emailVerifiedAt timestamp', async () => {
    const { user } = await seedUser(true)
    expect(user.emailVerifiedAt).toBeInstanceOf(Date)
    const token = await seedResetToken(user.id)

    await resetPassword(token, NEW_PASSWORD)

    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt?.getTime()).toBe(user.emailVerifiedAt?.getTime())
  })

  it('revokes every existing session', async () => {
    const { user, email } = await seedUser()
    const loginResponse = await login(email, VALID_PASSWORD)
    const cookie = refreshCookiePair(loginResponse)
    expect(cookie).toBeDefined()
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, NEW_PASSWORD)
    expect(response.status).toBe(200)

    const refreshAfterReset = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie as string)
    expect(refreshAfterReset.status).toBe(401)
  })

  it('revokes every session before storing the new password, so a failed write leaves none alive', async () => {
    const { user, email } = await seedUser()
    const loginResponse = await login(email, VALID_PASSWORD)
    const cookie = refreshCookiePair(loginResponse)
    expect(cookie).toBeDefined()
    const token = await seedResetToken(user.id)

    // Mutate the subclass prototype, not BaseRepository's: that would hit every repository.
    await withMutatedMethod(
      UserRepository.prototype,
      'update',
      () => {
        throw new Error('simulated password write failure')
      },
      async () => {
        const response = await resetPassword(token, NEW_PASSWORD)
        expect(response.status).toBe(500)
      }
    )

    const refreshAfterFailedReset = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie as string)
    expect(refreshAfterFailedReset.status).toBe(401)
  })

  it('lets the new password log in', async () => {
    const { user, email } = await seedUser()
    const token = await seedResetToken(user.id)
    await resetPassword(token, NEW_PASSWORD)

    const response = await login(email, NEW_PASSWORD)

    expect(response.status).toBe(200)
  })

  it('no longer accepts the old password', async () => {
    const { user, email } = await seedUser()
    const token = await seedResetToken(user.id)
    await resetPassword(token, NEW_PASSWORD)

    const response = await login(email, VALID_PASSWORD)

    expect(response.status).toBe(401)
  })

  it('rejects a new password below the registration policy’s floor as a field-level 400, before the token is even looked at', async () => {
    const { user } = await seedUser()
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, 'short1')

    expect(response.status).toBe(400)
    const errors = envelopeOf<unknown>(response) as unknown as { errors?: { password?: string[] } }
    expect(errors.errors?.password).toEqual(expect.arrayContaining([expect.any(String)]))

    // The token must still be live — a validation failure must not have
    // spent it the way a real claim attempt would.
    const retried = await resetPassword(token, NEW_PASSWORD)
    expect(retried.status).toBe(200)
  })

  it('rate limits after the configured number of attempts (IP-keyed)', async () => {
    // The production limiter allows 10 attempts per 15 minutes
    // (rate-limit.middleware.ts). A fixed, never-valid token throughout —
    // this test is about volume, not about a real redemption.
    for (let index = 0; index < 10; index += 1) {
      const response = await resetPassword('a'.repeat(64), NEW_PASSWORD)
      expect(response.status).toBe(400)
    }
    const limited = await resetPassword('a'.repeat(64), NEW_PASSWORD)

    expect(limited.status).toBe(429)
    expect(limited.headers).toHaveProperty('ratelimit-limit')
  })

  it('completes the real mailed flow end to end: forgot-password -> reset -> login', async () => {
    const { user, email } = await seedUser(false)

    const forgotResponse = await forgotPassword(email)
    expect(forgotResponse.status).toBe(202)

    const messages = await findMailpitMessages(email)
    expect(messages).toHaveLength(1)
    const detail = await getMailpitMessage(messages[0]?.ID ?? '')
    const token = /token=([0-9a-f]+)/.exec(detail.Text)?.[1]
    expect(token).toBeDefined()
    await deleteMailpitMessage(messages[0]?.ID ?? '')

    const resetResponse = await resetPassword(token ?? '', NEW_PASSWORD)
    expect(resetResponse.status).toBe(200)

    // The reset also verified the mailbox — proven independently of login's
    // own guard, not just inferred from login succeeding below.
    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date)

    const loginResponse = await login(email, NEW_PASSWORD)
    expect(loginResponse.status).toBe(200)
  })

  it('drops Google links from a never-verified account on reset, so a squatter’s Google identity no longer resolves to it', async () => {
    // Legacy state, seeded directly: after E1, an unverified Google identity can no longer create it.
    const { user, email } = await seedUser(false)
    // A real account always carries this row (register()'s own invariant,
    // see auth-provider.model.ts) — seeded directly here since `seedUser`
    // bypasses `register()`. `deleteFederatedForUser` only ever removes
    // non-'email' rows, so this one must exist up front for the assertion
    // below to mean anything.
    await authProviderRepository.create({
      userId: user.id,
      provider: 'email',
      providerId: email,
    })
    const squatterGoogleId = randomUUID()
    await authProviderRepository.create({
      userId: user.id,
      provider: 'google',
      providerId: squatterGoogleId,
    })
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, NEW_PASSWORD)
    expect(response.status).toBe(200)

    expect(
      await authProviderRepository.findByProviderAndId('google', squatterGoogleId)
    ).toBeUndefined()
    const providers = await authProviderRepository.findByUser(user.id)
    expect(providers.map((row) => row.provider)).toEqual(['email'])
    await expect(
      findOrCreateByGoogle(unverifiedGoogleProfile(squatterGoogleId, email))
    ).rejects.toMatchObject({ statusCode: 403, code: 'email_not_verified' })
  })

  it('keeps the Google link of an already-verified account through a reset', async () => {
    const { user } = await seedUser(true)
    const googleId = randomUUID()
    await authProviderRepository.create({
      userId: user.id,
      provider: 'google',
      providerId: googleId,
    })
    const token = await seedResetToken(user.id)

    const response = await resetPassword(token, NEW_PASSWORD)
    expect(response.status).toBe(200)

    const link = await authProviderRepository.findByProviderAndId('google', googleId)
    expect(link?.userId).toBe(user.id)
  })
})
