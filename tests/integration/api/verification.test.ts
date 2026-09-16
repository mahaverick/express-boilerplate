// tests/integration/api/verification.test.ts
//
// Integration tests for POST /api/v1/auth/verify-email. Every assertion
// runs against the real per-worker Postgres database — rows are seeded via
// repository calls (not through POST /auth/register, whose contract may
// change independently) and cleaned up in afterEach.
//
// The identical-response tests are the security core: they pin that a
// wrong password, an unknown token, and a malformed body all produce
// byte-identical responses — distinguishable failures would be a
// token-state oracle, and a distinguishable wrong-password failure would
// tell whoever holds a link that the address is squatted.
import { randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import request from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REFRESH_TOKEN_COOKIE_NAME } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { getRedis } from '@/services/redis.service'
import { hashPassword } from '@/utilities/password.utilities'
import { issueToken } from '@/utilities/token.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import {
  assertNoMailpitMessage,
  drainMailpit,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'

const app = createApp()
const userRepository = new UserRepository()

// verifyEmail/resendVerification/register now enqueue via BullMQ
// (addEmailJob) instead of calling sendMail() directly — see
// tests/integration/api/auth.test.ts's identical comment for why every
// mail-delivery assertion in this file needs a live Worker to actually
// process what these endpoints enqueue.
const worker: Worker<EmailJobData> = startEmailWorker()

afterAll(async () => {
  await worker.close()
  await getEmailQueue().obliterate({ force: true })
  await closeQueue()
})

const VALID_PASSWORD = 'correct horse battery staple'

/**
 * POST to /api/v1/auth/verify-email with the given token and password.
 * @param token - The raw verification token.
 * @param password - The account password to present.
 * @returns The supertest response.
 */
async function verify(token: string, password: string): Promise<request.Response> {
  return request(app).post('/api/v1/auth/verify-email').send({ token, password })
}

/**
 * Seed an unverified user with a hashed password and a live
 * email_verification token.
 *
 * Built from repository calls rather than POST /auth/register so this
 * file does not depend on the registration contract (which may change
 * independently in Task 8).
 * @returns The user and raw token.
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

    // No `password` field at all. Without the try/catch around parseBody in
    // the controller, this returns "Validation failed" with fieldErrors and
    // the assertion below fails — which is the point of including it.
    const malformed = await request(app)
      .post('/api/v1/auth/verify-email')
      .set('X-Request-Id', fixedRequestId)
      .send({ token })

    expect(malformed.body).toEqual(unknownToken.body)

    // Direct equality, not "both are 4xx". A distinguishable wrong-password
    // failure tells an attacker holding a link that the address is squatted.
    expect(wrongPassword.body).toEqual(unknownToken.body)
    expect(wrongPassword.status).toBe(unknownToken.status)
    expect(wrongPassword.status).toBe(400)
  })

  it('burns the token on a wrong password', async () => {
    const { token } = await seedUnverifiedUser()
    await verify(token, 'not-the-right-password')

    // Intended, and documented in SECURITY.md: one link is one attempt, so a
    // leaked link gives an attacker exactly one guess.
    const retried = await verify(token, VALID_PASSWORD)
    expect(retried.status).toBe(400)
  })

  it('refuses the same token twice', async () => {
    const { token } = await seedUnverifiedUser()
    const first = await verify(token, VALID_PASSWORD)
    expect(first.status).toBe(200)

    const second = await verify(token, VALID_PASSWORD)
    expect(second.status).toBe(400)
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

    // markEmailVerified returns undefined here — already verified — and that
    // is SUCCESS. Answering 400 would make a double-click an error.
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

    // The assertion the other tests cannot make: a status code cannot tell
    // you whether the column was written.
    const row = await userRepository.findById(user.id)
    expect(row?.emailVerifiedAt).toBeNull()
  })
})

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database, or the shared Redis
 * rate-limit counters, may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `resend-verification-${randomUUID()}@example.test`
}

/**
 * POST to /api/v1/auth/resend-verification with the given address.
 * @param email - The address to submit.
 * @returns The supertest response.
 */
async function resend(email: string): Promise<request.Response> {
  return request(app).post('/api/v1/auth/resend-verification').send({ email })
}

/**
 * Register a user through the real HTTP endpoint and track it for cleanup.
 *
 * Own copy of auth.test.ts's helper of the same name and shape — that
 * file's own comment explains why each integration file keeps its own
 * rather than sharing one across files.
 * @param overrides - Fields to override on the default registration body.
 * @returns The email used and the created (unverified) user row.
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
 * Register a user and mark them verified, so a test only needs a usable
 * account without walking the verification flow. Marking is done here, in
 * the helper — never by weakening resendVerification's own guard.
 * @param overrides - Fields to override on the default registration body.
 * @returns The email used and the verified user row.
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
 * Register a fresh user, mark them verified, and log in through the real
 * HTTP endpoints.
 *
 * Own copy of auth-refresh.test.ts's helper of the same name — that file's
 * own comment explains why each integration file keeps its own, and why
 * this one takes `createdIds` as a parameter instead of closing over a
 * describe-scoped array the way `registerUser` above does.
 * @param createdIds - Array to push the created user's id onto, for `afterEach` cleanup.
 * @returns The login response, the email used, and the verified user row.
 */
async function registerAndLogin(
  createdIds: string[]
): Promise<{ response: request.Response; email: string; user: User }> {
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
 * The exact `name=value` pair for the refresh-token cookie out of a
 * response's raw `Set-Cookie` header. Own copy of auth-refresh.test.ts's
 * helper of the same name — see that file's own comment for why each
 * integration file keeps its own rather than sharing one.
 * @param response - The supertest response.
 * @returns The `refreshToken=...` pair, or undefined if the cookie was not set.
 */
function refreshCookiePair(response: request.Response): string | undefined {
  const cookieLines = response.headers['set-cookie'] as string[] | undefined
  const line = cookieLines?.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
  return line?.split(';', 1)[0]
}

const RESEND_VERIFICATION_IP_KEY_PATTERN = 'rl:resend-verification-ip:*'
const RESEND_VERIFICATION_EMAIL_KEY_PATTERN = 'rl:resend-verification-email:*'

/**
 * Every Redis key matching a pattern, via SCAN rather than KEYS — the same
 * choice global-setup.ts's own `clearRateLimitCounters` makes, and for the
 * same reason (KEYS blocks the whole server; this may be a developer's own
 * Redis with other data in it). Shared by the cleanup and wiring-proof
 * helpers below.
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
 * Clear the resend-verification IP limiter's counter before every test in
 * this describe block.
 *
 * This is the first genuinely TIGHT (5/hour), IP-ALONE-keyed limiter in
 * this codebase. Every earlier IP-alone limiter (register, logout) is
 * generous, and the one tight limiter that already existed (login) never
 * needs this: its key composes IP WITH the submitted email
 * (`loginRateLimitKey`), so each test's unique address gets its own
 * bucket. Here every request from this suite's one client address shares
 * ONE bucket regardless of address, and Redis is cleared only once, in
 * global setup, for the whole run (tests/helpers/global-setup.ts) — so
 * without this, the sixth call anywhere in this describe block answers 429
 * instead of 202, and the assertion that goes red is often several tests
 * away from the one that actually spent the budget.
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
  // Deliberately no describe-local `createdIds`/`afterEach` pair here: the
  // module-level ones declared above (used by `seedUnverifiedUser`) already
  // apply to every test in this file, and `registerUser`/`registerVerifiedUser`
  // below close over that same array. A second, shadowing `createdIds`
  // scoped to just this describe would split cleanup across two arrays for
  // no benefit — `registerAndLogin` below still takes `createdIds` as an
  // explicit parameter (matching auth-refresh.test.ts's own helper of the
  // same name) and is called with the one module-level array.
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

  it('mails only the unverified address', async () => {
    const unknown = uniqueEmail()
    const { email: unverified } = await registerUser()
    const { email: verified } = await registerVerifiedUser()
    await drainMailpit(unverified)
    await drainMailpit(verified)

    for (const email of [unknown, unverified, verified]) {
      await resend(email)
    }

    // The positive assertion runs FIRST and polls to completion
    // (findMailpitMessages) — by the time it resolves, the fire-and-forget
    // mail this loop triggered has either arrived or never will. Ordering
    // the negatives (unknown, verified) AFTER it, rather than racing all
    // three together, gives an errant send the same window to land before
    // either negative check starts. assertNoMailpitMessage itself now
    // polls its own bounded budget too (see its own comment) — belt and
    // suspenders, not redundant: CARRY note from Task 1 names this helper's
    // history of looking like it polls without actually doing so.
    expect(await findMailpitMessages(unverified)).toHaveLength(1)
    await assertNoMailpitMessage(unknown)
    await assertNoMailpitMessage(verified)
  })

  it('invalidates the previous link when a new one is sent, and the new one verifies', async () => {
    const { email, user } = await registerUser()
    const first = await issueToken(user.id, 'email_verification', 60_000)
    await drainMailpit(email)

    await resend(email)

    // Synchronization point: resendVerificationMail's send runs AFTER its
    // revoke (see that function's own comment on why the order is load-
    // bearing), and both are unawaited by the 202 response. Waiting for
    // the resend mail to actually arrive is what proves the revoke has
    // already run before the assertions below — a bare 202, or a fixed
    // sleep, proves nothing about background work that hasn't necessarily
    // finished yet.
    const messages = await findMailpitMessages(email)
    expect(messages).toHaveLength(1)
    const detail = await getMailpitMessage(messages[0]?.ID ?? '')
    const secondToken = /token=([0-9a-f]+)/.exec(detail.Text)?.[1]
    expect(secondToken).toBeDefined()

    // Two live links at once means a token read out of an older mail still
    // works after the user has re-requested — the state single-use exists
    // to prevent.
    const oldAttempt = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: first.raw, password: VALID_PASSWORD })
    expect(oldAttempt.status).toBe(400)

    // Not just "the old one is dead" — the NEW one must actually work. A
    // resendVerificationMail with send and revoke swapped would also make
    // the old token fail (collateral damage, not on purpose), and this
    // assertion is what tells the two apart.
    const newAttempt = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: secondToken ?? '', password: VALID_PASSWORD })
    expect(newAttempt.status).toBe(200)
  })

  it('leaves a live refresh token alone when it clears old links', async () => {
    // The regression this guards is not hypothetical: revokeAllForUser
    // matches on userId alone, so reaching for it here would log the user
    // out of every device as a side effect of asking for an email.
    const { response: login, email, user } = await registerAndLogin(createdIds)
    await sql`update users set email_verified_at = null where id = ${user.id}`
    await drainMailpit(email)

    await resend(email)

    // Same synchronization reasoning as the previous test: the refresh
    // token this test asserts on must not be checked until the revoke that
    // could have touched it (wrongly) is known to have already run.
    // Without this, the assertion below is vacuous — it would pass whether
    // or not the revoke had executed yet.
    expect(await findMailpitMessages(email)).toHaveLength(1)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookiePair(login) as string)
    expect(refreshed.status).toBe(200)
  })

  it('runs both limiters — proven by counters incrementing under both prefixes', async () => {
    // RateLimit-* headers alone cannot prove this: express-rate-limit sets
    // them on every response it lets through, and the second limiter's
    // headers simply overwrite the first's — a header check only ever
    // proves the LAST limiter in the chain ran. Reading the store directly
    // is the only way to prove both fired; either factory could be deleted
    // from the route in auth.routes.ts and a header-only assertion would
    // stay green.
    const email = uniqueEmail()

    await resend(email)

    const ipKeys = await redisKeysMatching(RESEND_VERIFICATION_IP_KEY_PATTERN)
    const emailKeys = await redisKeysMatching(RESEND_VERIFICATION_EMAIL_KEY_PATTERN)
    expect(ipKeys.length).toBeGreaterThan(0)
    expect(emailKeys.length).toBeGreaterThan(0)
  })
})
