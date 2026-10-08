/**
 * @file Integration tests for POST /api/v1/auth/change-password,
 * against the real per-worker Postgres database and the real compose
 * Redis — same conventions as tests/integration/api/forgot-password.test.ts
 * (mail/worker setup) and tests/integration/api/auth.test.ts
 * (login/token mechanics). Both the "email" and "notification" BullMQ
 * workers run for the whole file, so the controller's
 * `addNotificationJob` call actually reaches Mailpit. Most tests sign
 * a bearer token directly with `signAccessToken`
 * (tests/integration/api/profile.test.ts's own approach) rather than
 * going through POST /auth/login, since they are about what happens
 * after authentication — the one exception is the "revokes every other
 * session" test below (see its own JSDoc).
 */

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
import { isSessionDenied } from '@/services/session-denylist.service'
import { issueRefreshToken, rotateRefreshToken, signAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import {
  isTokenRowLive,
  refreshCookieHeader,
  rotatedSessionId,
  sessionWithSibling,
  type SessionWithSibling,
} from '../../helpers/grace-sibling'
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

  /**
   * The assertion that proves the design. Both tokens below must come
   * from real logins, not a fabricated session id:
   * `revokeAllForUserExceptSession`'s denial only has an existing
   * `user_tokens` row to act on for a session that a real login
   * actually created. A fabricated `randomUUID()` session id has no
   * such row, is never denied by anything, and would make this
   * assertion pass whether or not the endpoint under test does
   * anything at all.
   */
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

    // Session B (a different device) is refused immediately — it has not expired, and nothing about it changed except that this endpoint ran.
    const afterB = await probe(tokenB as string)
    expect(afterB.status).toBe(401)
    // Session A (the caller who made the change) still works — sparing it is the point of revokeAllForUserExceptSession over revokeAllSessions.
    const afterA = await probe(tokenA as string)
    expect(afterA.status).toBe(200)
  })

  it('revokes every session when the caller’s own token carries no sid claim', async () => {
    // The fallback branch: requireAuth still accepts a token minted before the sid claim existed, so there is no session to spare and the controller revokes everything instead (see password-changed.template.ts's own doc for why the emailed copy still says "every other session").
    const email = uniqueEmail()
    const { user } = await createUserWithPassword(email)

    const loginResponse = await login(email, CURRENT_PASSWORD)
    expect(loginResponse.status).toBe(200)
    const sessionToken = envelopeOf<{ accessToken: string }>(loginResponse).data?.accessToken
    expect(await probe(sessionToken as string)).toHaveProperty('status', 200)

    // Hand-signed with sub only — the sid key is absent, not undefined; signAccessToken cannot produce this, since it requires a session id.
    const sidLessToken = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const changeResponse = await changePasswordRequest(sidLessToken, CURRENT_PASSWORD, NEW_PASSWORD)
    expect(changeResponse.status).toBe(200)

    // The real session dies, which is what "revoke everything" has to mean for this to be the safe fallback rather than a silent no-op.
    const afterSession = await probe(sessionToken as string)
    expect(afterSession.status).toBe(401)

    // The caller's sid-less token is not denied: it names no session, so there is no denylist key to write, and it stops working only at its own expiry (requireAuth's pre-sid tolerance).
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
    // Five, not reset-password's ten: this endpoint is a password oracle like login, so it carries login's budget rather than the token-redemption flow's.
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

    // Proves the send routed through addNotificationJob (which inserts the in-app row before enqueuing the paired email), not addEmailJob called directly.
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

/**
 * Change the password as `bearer`, presenting `cookie` when given.
 * @param bearer - The caller's access token.
 * @param cookie - The `Cookie` header to send, if any.
 * @returns The supertest response.
 */
async function changePasswordWithCookie(bearer: string, cookie?: string): Promise<Response> {
  const pending = request(app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${bearer}`)
  if (cookie !== undefined) pending.set('Cookie', cookie)
  return pending.send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD })
}

/**
 * A grace-window replay mints a sibling: a second live chain in the caller's
 * own session. Sessions here are issued with `issueRefreshToken`, so each has
 * a real `user_tokens` row to revoke and deny. The refresh cookie the browser
 * sends on this route names the caller's chain; without a usable one the
 * whole session is spared, as before.
 */
describe('POST /api/v1/auth/change-password and a grace sibling', () => {
  it('ends the sibling chain when the caller presents its refresh cookie, and keeps the caller', async () => {
    const { user } = await createUserWithPassword()
    const caller = await sessionWithSibling(user)
    const other = await issueRefreshToken(user.id, randomUUID())

    const response = await changePasswordWithCookie(
      caller.bearer,
      refreshCookieHeader(caller.head.raw)
    )

    expect(response.status).toBe(200)
    await expect(rotateRefreshToken(other.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(other.sessionId)).toBe(true)
    // Never the caller's own sid: that would end the caller's access token too.
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    expect(await probe(caller.bearer)).toHaveProperty('status', 200)
    // The caller rotates before the sibling is replayed: a replay of the revoked sibling is reuse and ends the whole session.
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
    await expect(rotateRefreshToken(caller.sibling.raw)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('keeps the caller’s grace window after ending the sibling: a later two-tab race still gets a sibling', async () => {
    const { user } = await createUserWithPassword()
    const caller = await sessionWithSibling(user)

    const response = await changePasswordWithCookie(
      caller.bearer,
      refreshCookieHeader(caller.head.raw)
    )

    expect(response.status).toBe(200)
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
    // A second tab's racing refresh of the same cookie, inside the grace window.
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
  })

  it('spares the sibling when no refresh cookie is presented', async () => {
    const { user } = await createUserWithPassword()
    const caller = await sessionWithSibling(user)
    const other = await issueRefreshToken(user.id, randomUUID())

    const response = await changePasswordWithCookie(caller.bearer)

    expect(response.status).toBe(200)
    expect(await isSessionDenied(other.sessionId)).toBe(true)
    expect(await isTokenRowLive(other.raw)).toBe(false)
    expect(await rotatedSessionId(caller.sibling.raw)).toBe(caller.head.sessionId)
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
  })

  it('spares the caller’s whole session for a cookie of another session of the user, and ends that session', async () => {
    const { user } = await createUserWithPassword()
    const caller = await sessionWithSibling(user)
    const other = await issueRefreshToken(user.id, randomUUID())

    const response = await changePasswordWithCookie(caller.bearer, refreshCookieHeader(other.raw))

    expect(response.status).toBe(200)
    await expect(rotateRefreshToken(other.raw)).rejects.toMatchObject({ statusCode: 401 })
    expect(await isSessionDenied(other.sessionId)).toBe(true)
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    expect(await rotatedSessionId(caller.sibling.raw)).toBe(caller.head.sessionId)
    expect(await rotatedSessionId(caller.head.raw)).toBe(caller.head.sessionId)
  })

  it.each([
    ['an unknown cookie', (_caller: SessionWithSibling) => 'not-a-real-refresh-token'],
    // The head's predecessor: same user and session, but revoked by its rotation.
    ['a revoked cookie of the caller’s session', (caller: SessionWithSibling) => caller.spent],
  ])('spares the caller’s whole session for %s', async (_label, cookieRaw) => {
    const { user } = await createUserWithPassword()
    const caller = await sessionWithSibling(user)
    const other = await issueRefreshToken(user.id, randomUUID())

    const response = await changePasswordWithCookie(
      caller.bearer,
      refreshCookieHeader(cookieRaw(caller))
    )

    expect(response.status).toBe(200)
    expect(await isSessionDenied(other.sessionId)).toBe(true)
    expect(await isSessionDenied(caller.head.sessionId)).toBe(false)
    expect(await isTokenRowLive(caller.sibling.raw)).toBe(true)
    expect(await isTokenRowLive(caller.head.raw)).toBe(true)
  })
})
