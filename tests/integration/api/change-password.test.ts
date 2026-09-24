// tests/integration/api/change-password.test.ts
//
// Integration tests for POST /api/v1/auth/change-password, against the real
// per-worker Postgres database and the real compose Redis — same
// conventions as tests/integration/api/forgot-password.test.ts (mail/worker
// setup) and tests/integration/api/auth.test.ts (login/token mechanics).
// Both the "email" and "notification" BullMQ workers run for the whole
// file, so the controller's `addNotificationJob` call actually reaches
// Mailpit (see those two files' own comments for why both workers, not just
// one, are required).
//
// Most tests here sign a bearer token directly with `signAccessToken`
// (tests/integration/api/profile.test.ts's own approach) rather than going
// through POST /auth/login — they are about what happens AFTER
// authentication, not about login/session mechanics. The ONE exception is
// the "revokes every other session" test below, which MUST log in twice
// through the real HTTP endpoint: `revokeAllForUserExceptSession`'s denial
// only has an existing `user_tokens` row to act on for a session that a
// real login actually created. A fabricated `randomUUID()` session id has
// no such row, is never denied by anything, and would make that assertion
// pass whether or not the endpoint under test does anything at all — the
// exact vacuous-pass trap that has bitten this repo's session-revocation
// work before.
import { randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import jwt from 'jsonwebtoken'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashPassword } from '@/utilities/password.utilities'
import { signAccessToken } from '@/utilities/token.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import { deleteMailpitMessage, findMailpitMessages, getMailpitMessage } from '../../helpers/mailpit'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()

const worker: Worker<EmailJobData> = startEmailWorker()
const notificationWorker = startNotificationWorker()

afterAll(async () => {
  await worker.close()
  await notificationWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

const CURRENT_PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new secret passphrase'

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database, or the shared Redis
 * rate-limit counters, may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `change-password-${randomUUID()}@example.test`
}

/**
 * The envelope every controller response is wrapped in
 * (response.utilities.ts), narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * Cast a supertest response's body to a known envelope shape.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

/**
 * Create a disposable, already-verified user with a real, hashed password,
 * and sign an access token for it directly — see this file's header
 * comment for why most tests here do not need a real login to exercise
 * `POST /auth/change-password` itself.
 * @param email - The address to create the user with. Defaults to a fresh unique address.
 * @returns The created (and re-read) user row and a valid bearer token for it.
 */
async function createUserWithPassword(
  email: string = uniqueEmail()
): Promise<{ user: User; token: string }> {
  const created = await userRepository.create({
    email,
    passwordHash: await hashPassword(CURRENT_PASSWORD),
  })
  createdIds.push(created.id)
  await sql`update users set email_verified_at = now() where id = ${created.id}`
  const user = await userRepository.findById(created.id)
  if (!user) throw new Error(`createUserWithPassword: user vanished for ${email}`)
  return { user, token: signAccessToken(user, randomUUID()) }
}

/**
 * Create a disposable, already-verified, FEDERATED-ONLY user — no
 * `passwordHash` at all, the Google-only shape CLAUDE.md's OAuth section
 * documents — and sign an access token for it directly.
 * @returns The created (and re-read) user row and a valid bearer token for it.
 */
async function createFederatedUser(): Promise<{ user: User; token: string }> {
  const email = uniqueEmail()
  const created = await userRepository.create({ email })
  createdIds.push(created.id)
  await sql`update users set email_verified_at = now() where id = ${created.id}`
  const user = await userRepository.findById(created.id)
  if (!user) throw new Error(`createFederatedUser: user vanished for ${email}`)
  return { user, token: signAccessToken(user, randomUUID()) }
}

/**
 * POST to /api/v1/auth/change-password with a bearer token.
 * @param token - The caller's access token.
 * @param currentPassword - The submitted current password.
 * @param newPassword - The submitted new password.
 * @returns The supertest response.
 */
async function changePasswordRequest(
  token: string,
  currentPassword: string,
  newPassword: string
): Promise<Response> {
  return request(app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${token}`)
    .send({ currentPassword, newPassword })
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
 * GET /api/v1/profile as a probe for whether a bearer token still works —
 * the same technique tests/integration/api/auth.test.ts's own
 * reset-password revocation test uses.
 * @param token - The access token to probe with.
 * @returns The supertest response.
 */
async function probe(token: string): Promise<Response> {
  return request(app).get('/api/v1/profile').set('Authorization', `Bearer ${token}`)
}

describe('POST /api/v1/auth/change-password', () => {
  it('changes the password and returns 200', async () => {
    const { token } = await createUserWithPassword()

    const response = await changePasswordRequest(token, CURRENT_PASSWORD, NEW_PASSWORD)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: 'Password has been changed.',
      statusCode: 200,
      // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
      data: null,
    })
  })

  it('the old password no longer logs in; the new one does', async () => {
    const email = uniqueEmail()
    const { token } = await createUserWithPassword(email)

    const changeResponse = await changePasswordRequest(token, CURRENT_PASSWORD, NEW_PASSWORD)
    expect(changeResponse.status).toBe(200)

    const oldLogin = await login(email, CURRENT_PASSWORD)
    expect(oldLogin.status).toBe(401)

    const newLogin = await login(email, NEW_PASSWORD)
    expect(newLogin.status).toBe(200)
  })

  // THE ASSERTION THAT PROVES THE DESIGN — see this file's header comment
  // for why both tokens below must come from real logins, not a fabricated
  // session id.
  it('revokes every other session, but leaves the session that made the change working', async () => {
    const email = uniqueEmail()
    await createUserWithPassword(email)

    const loginA = await login(email, CURRENT_PASSWORD)
    const loginB = await login(email, CURRENT_PASSWORD)
    const tokenA = envelopeOf<{ accessToken: string }>(loginA).data?.accessToken
    const tokenB = envelopeOf<{ accessToken: string }>(loginB).data?.accessToken
    expect(tokenA).toBeDefined()
    expect(tokenB).toBeDefined()

    // Both sessions genuinely work before the change.
    const beforeA = await probe(tokenA as string)
    const beforeB = await probe(tokenB as string)
    expect(beforeA.status).toBe(200)
    expect(beforeB.status).toBe(200)

    const changeResponse = await changePasswordRequest(
      tokenA as string,
      CURRENT_PASSWORD,
      NEW_PASSWORD
    )
    expect(changeResponse.status).toBe(200)

    // Session B (a different device) is refused immediately — it has NOT
    // expired, and nothing about it changed except that this endpoint ran.
    const afterB = await probe(tokenB as string)
    expect(afterB.status).toBe(401)
    // Session A (the caller who made the change) still works — sparing it
    // is the entire point of `revokeAllForUserExceptSession` over
    // `revokeAllSessions`.
    const afterA = await probe(tokenA as string)
    expect(afterA.status).toBe(200)
  })

  it('revokes every session when the caller’s own token carries no sid claim', async () => {
    // The fallback branch. `requireAuth` still accepts an access token minted
    // before the `sid` claim existed (its `payload.sid &&` tolerance), so
    // `request.sessionId` is undefined and there is no session to spare —
    // the controller revokes everything instead of sparing one.
    //
    // This is also the branch that made the emailed copy hedge: it once said
    // "only the device you used is still logged in", which is false here.
    const email = uniqueEmail()
    const { user } = await createUserWithPassword(email)

    const loginResponse = await login(email, CURRENT_PASSWORD)
    expect(loginResponse.status).toBe(200)
    const sessionToken = envelopeOf<{ accessToken: string }>(loginResponse).data?.accessToken
    expect(await probe(sessionToken as string)).toHaveProperty('status', 200)

    // Hand-signed with `sub` ONLY — the `sid` key is absent, not undefined.
    // `signAccessToken` cannot produce this; it requires a session id.
    const sidLessToken = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const changeResponse = await changePasswordRequest(sidLessToken, CURRENT_PASSWORD, NEW_PASSWORD)
    expect(changeResponse.status).toBe(200)

    // The real session dies, which is what "revoke everything" has to mean
    // for this to be the safe fallback rather than a silent no-op.
    const afterSession = await probe(sessionToken as string)
    expect(afterSession.status).toBe(401)

    // The caller's own sid-less token is NOT denied, and that is correct
    // rather than a gap: it names no session, so there is no denylist key to
    // write. It stops working when it expires, at most ACCESS_TOKEN_TTL
    // later — requireAuth's documented pre-`sid` tolerance, unchanged by
    // this endpoint. Pinned so that a future change which starts denying it
    // is a deliberate decision rather than an accident.
    const afterSidLess = await probe(sidLessToken)
    expect(afterSidLess.status).toBe(200)
  })

  it('rejects a wrong current password with 400', async () => {
    const { token } = await createUserWithPassword()

    const response = await changePasswordRequest(
      token,
      'definitely-the-wrong-password',
      NEW_PASSWORD
    )

    expect(response.status).toBe(400)
  })

  it('rejects a federated-only account (no password to verify against) with 400', async () => {
    const { token } = await createFederatedUser()

    const response = await changePasswordRequest(token, 'any-password-at-all', NEW_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('rejects a new password identical to the current one with 400', async () => {
    const { token } = await createUserWithPassword()

    const response = await changePasswordRequest(token, CURRENT_PASSWORD, CURRENT_PASSWORD)

    expect(response.status).toBe(400)
  })

  it('does not change the password when the new-password validation fails', async () => {
    const email = uniqueEmail()
    const { token } = await createUserWithPassword(email)

    const response = await changePasswordRequest(token, CURRENT_PASSWORD, 'short1')

    expect(response.status).toBe(400)
    const stillWorks = await login(email, CURRENT_PASSWORD)
    expect(stillWorks.status).toBe(200)
  })

  it('rate limits repeated wrong-current-password attempts, keyed by the authenticated user', async () => {
    // The production limiter allows five attempts per 15 minutes
    // (rate-limit.middleware.ts), keyed on `request.user.id` — a fresh user
    // per test means a fresh counter, with nothing else in this file able
    // to have already spent it. Five, not reset-password's ten: this
    // endpoint is a password oracle like login, so it carries login's
    // budget rather than the token-redemption flow's.
    const { token } = await createUserWithPassword()

    for (let index = 0; index < 5; index += 1) {
      const response = await changePasswordRequest(token, 'still-the-wrong-password', NEW_PASSWORD)
      expect(response.status).toBe(400)
    }
    const limited = await changePasswordRequest(token, 'still-the-wrong-password', NEW_PASSWORD)

    expect(limited.status).toBe(429)
    expect(limited.headers).toHaveProperty('ratelimit-limit')
  })

  it('mails a password-changed notice to the account owner', async () => {
    const email = uniqueEmail()
    const { user, token } = await createUserWithPassword(email)

    const response = await changePasswordRequest(token, CURRENT_PASSWORD, NEW_PASSWORD)
    expect(response.status).toBe(200)

    const messages = await findMailpitMessages(email)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toContain('password was changed')
    const detail = await getMailpitMessage(messages[0]?.ID ?? '')
    expect(detail.Text).toContain('signed out')
    await deleteMailpitMessage(messages[0]?.ID ?? '')

    // Proves the send routed through addNotificationJob (which inserts the
    // in-app row before enqueuing the paired email —
    // notification.worker.ts's own header comment), not addEmailJob called
    // directly.
    const notifications = await sql`
      select * from notifications where user_id = ${user.id} and type = 'password_changed'
    `
    expect(notifications).toHaveLength(1)
  })

  it('rejects a request with no token', async () => {
    const response = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD })

    expect(response.status).toBe(401)
  })
})
