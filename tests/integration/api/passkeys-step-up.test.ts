/**
 * @file Confirming it's you with a passkey, under
 * `/api/v1/auth/passkeys/step-up`. A software authenticator makes real
 * registration and assertion responses, so `@simplewebauthn/server` verifies
 * every signature for real. Covers the fresh `auth_time` and the platform-tenant
 * audit row (`method: 'passkey'`), the user's own credentials only, the
 * single-use challenge bound to the user and the session, a challenge from
 * another purpose in both directions, the counter rule, and the mode `off` 404.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { issuePasskeyChallenge } from '@/services/passkey-challenge.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { verifyAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { SoftwareAuthenticator, type AssertionJson } from '../../helpers/passkey-authenticator'
import { platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'

const mode = vi.hoisted(() => ({ current: 'optional' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), PASSKEY_MODE: mode.current }) }
})

const app = createApp()
const BASE = '/api/v1/auth/passkeys'

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

const usedEmails: string[] = []

beforeEach(async () => {
  mode.current = 'optional'
  await clearRateLimiter('passkey-step-up')
  await clearRateLimiter('passkey-manage')
  await clearRateLimiter('passkey-sign-in')
})

afterEach(async () => {
  await truncateAuditLogs()
  if (usedEmails.length === 0) return
  await sql`delete from email_messages where recipient = any(${usedEmails})`
  await sql`delete from users where email = any(${usedEmails})`
  usedEmails.length = 0
})

/**
 * The response envelope, with the fields these tests read.
 */
interface Envelope {
  message: string
  code: string
  data: {
    challengeId: string
    options: { challenge: string; allowCredentials: { id: string; transports?: string[] }[] }
    accessToken: string
  }
}

/**
 * Read a response's JSON body as the envelope.
 * @param response - The supertest response.
 * @returns The typed body.
 */
function envelope(response: { body: unknown }): Envelope {
  return response.body as Envelope
}

/**
 * One signed-in session: the user, the bearer token and the session id in it.
 */
interface Session {
  userId: string
  email: string
  token: string
  sid: string
}

/**
 * The `sid` and `auth_time` claims of a token this server issued.
 * @param token - The access token.
 * @returns Its claims.
 * @throws {Error} When the token does not verify.
 */
function claims(token: string): { sid: string | undefined; authTime: number | undefined } {
  const verified = verifyAccessToken(token)
  if (!verified.ok) throw new Error('unverifiable token')
  return { sid: verified.payload.sid, authTime: verified.payload.auth_time }
}

/**
 * Sign a web address in by a real link: a new session each call.
 * @param email - The address.
 * @returns The session.
 */
async function signIn(email: string): Promise<Session> {
  const session = await signInByLink(email, 'web')
  const { sid } = claims(session.accessToken)
  if (sid === undefined) throw new Error('the sign-in issued a token without sid')
  return { userId: session.userId, email, token: session.accessToken, sid }
}

/**
 * A fresh tracked address.
 * @returns The address.
 */
function newEmail(): string {
  const email = `pk-step-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * Create a passkey for a session's user through the real registration routes.
 * @param session - The signed-in session (recent, so creating is allowed).
 * @param authenticator - The software authenticator to register.
 */
async function register(session: Session, authenticator: SoftwareAuthenticator): Promise<void> {
  const asked = await request(app)
    .post(`${BASE}/registration/options`)
    .set('Authorization', `Bearer ${session.token}`)
    .send({ app: 'web' })
  const created = await request(app)
    .post(`${BASE}/registration/verify`)
    .set('Authorization', `Bearer ${session.token}`)
    .send({
      app: 'web',
      challengeId: envelope(asked).data.challengeId,
      response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
    })
  expect(created.status).toBe(201)
}

/**
 * A signed-in customer who holds one passkey.
 * @param authenticator - The authenticator to register.
 * @param email - The address; a fresh one by default.
 * @returns The session.
 */
async function customerWithPasskey(
  authenticator: SoftwareAuthenticator,
  email: string = newEmail()
): Promise<Session> {
  const session = await signIn(email)
  await register(session, authenticator)
  return session
}

/**
 * Ask for step-up options as one session.
 * @param token - The bearer token, or undefined for none.
 * @returns The response.
 */
function stepUpOptions(token: string | undefined): Promise<Response> {
  const pending = request(app).post(`${BASE}/step-up/options`)
  if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
  return pending.send({})
}

/**
 * Post a step-up verify.
 * @param token - The bearer token.
 * @param challengeId - The challenge id.
 * @param response - The assertion.
 * @returns The response.
 */
function stepUpVerify(
  token: string,
  challengeId: string,
  response: AssertionJson
): Promise<Response> {
  return request(app)
    .post(`${BASE}/step-up/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ challengeId, response })
}

/**
 * Step up: ask for options, then post the authenticator's assertion.
 * @param session - The session confirming.
 * @param make - Builds the assertion from the challenge.
 * @returns The verify response.
 */
async function stepUp(
  session: Session,
  make: (challenge: string) => AssertionJson
): Promise<Response> {
  const asked = await stepUpOptions(session.token)
  expect(asked.status).toBe(200)
  return stepUpVerify(
    session.token,
    envelope(asked).data.challengeId,
    make(envelope(asked).data.options.challenge)
  )
}

/**
 * Move every refresh row of a session an hour into the past.
 * @param sid - The session.
 */
async function ageSession(sid: string): Promise<void> {
  await sql`
    update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
    where session_id = ${sid} and purpose = 'refresh'
  `
}

/**
 * The step-up audit entries about one user.
 * @param userId - The user.
 * @returns Each entry's action, metadata and tenant.
 */
async function stepUpAudits(
  userId: string
): Promise<{ action: string; metadata: unknown; tenantId: string }[]> {
  return sql`
    select action, metadata, tenant_id as "tenantId" from audit_logs
    where target_id = ${userId} and action like 'auth.step_up_%'
    order by occurred_at, id
  `
}

describe('POST /step-up/options', () => {
  it('answers a challenge and options that name the caller credentials, with user verification', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)

    const response = await stepUpOptions(session.token)

    expect(response.status).toBe(200)
    const { data } = envelope(response)
    expect(data.challengeId).toEqual(expect.any(String))
    expect(data.options.allowCredentials.map((entry) => entry.id)).toEqual([
      authenticator.credentialId,
    ])
    expect(data.options).toMatchObject({ userVerification: 'required' })
  })

  it('answers 409 NO_PASSKEY when the caller has no passkey', async () => {
    const session = await signIn(newEmail())

    const response = await stepUpOptions(session.token)

    expect(response.status).toBe(409)
    expect(envelope(response).code).toBe('NO_PASSKEY')
    expect(envelope(response).message).toBe(
      "You don't have a passkey yet. Use another method to confirm it's you."
    )
  })

  it('answers 401 with no bearer', async () => {
    const response = await stepUpOptions(undefined)

    expect(response.status).toBe(401)
  })

  it('answers the unknown-route 404 in mode off', async () => {
    mode.current = 'off'
    const session = await signIn(newEmail())

    const response = await stepUpOptions(session.token)

    expect(response.status).toBe(404)
  })
})

describe('POST /step-up/verify', () => {
  it('mints a fresh auth_time for the same session and audits method passkey on the platform tenant', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)
    await ageSession(session.sid)
    const before = Math.floor(Date.now() / 1000)

    const response = await stepUp(session, (challenge) =>
      authenticator.assertionResponse(challenge)
    )

    expect(response.status).toBe(200)
    expect(envelope(response).message).toBe('Identity confirmed.')
    expect(response.headers['cache-control']).toBe('no-store')
    const fresh = claims(envelope(response).data.accessToken)
    expect(fresh.sid).toBe(session.sid)
    expect(fresh.authTime).toBeGreaterThanOrEqual(before - 1)
    const [row] = await sql<{ at: Date }[]>`
      select max(authenticated_at) as at from user_tokens
      where session_id = ${session.sid} and purpose = 'refresh'`
    expect(new Date(row?.at ?? 0).getTime()).toBeGreaterThanOrEqual(before * 1000 - 1000)
    const platform = await platformTenant()
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_confirmed', metadata: { method: 'passkey' }, tenantId: platform.id },
    ])
    const [use] = await sql<{ lastUsedAt: Date | null }[]>`
      select last_used_at as "lastUsedAt" from user_passkeys where user_id = ${session.userId}`
    expect(use?.lastUsedAt).not.toBeNull()
  })

  it("answers 400 PASSKEY_VERIFICATION_FAILED for another user's credential, and mints nothing", async () => {
    const mine = new SoftwareAuthenticator()
    const theirs = new SoftwareAuthenticator()
    const session = await customerWithPasskey(mine)
    await customerWithPasskey(theirs)

    const response = await stepUp(session, (challenge) => theirs.assertionResponse(challenge))

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(await stepUpAudits(session.userId)).toEqual([])
  })

  it('answers 400 for a challenge bound to another session of the same user', async () => {
    const authenticator = new SoftwareAuthenticator()
    const email = newEmail()
    const asking = await customerWithPasskey(authenticator, email)
    const other = await signIn(email)
    const asked = await stepUpOptions(asking.token)

    const response = await stepUpVerify(
      other.token,
      envelope(asked).data.challengeId,
      authenticator.assertionResponse(envelope(asked).data.options.challenge)
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(await stepUpAudits(asking.userId)).toEqual([])
  })

  it('answers 400 on a replay: the challenge is single-use', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)
    const asked = await stepUpOptions(session.token)
    const assertion = authenticator.assertionResponse(envelope(asked).data.options.challenge)

    const first = await stepUpVerify(session.token, envelope(asked).data.challengeId, assertion)
    const second = await stepUpVerify(session.token, envelope(asked).data.challengeId, assertion)

    expect(first.status).toBe(200)
    expect(second.status).toBe(400)
    expect(envelope(second).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('answers 400 for a sign-in challenge presented to step-up', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)
    const issued = await issuePasskeyChallenge('sign_in', {})

    const response = await stepUpVerify(
      session.token,
      issued.challengeId,
      authenticator.assertionResponse(issued.challenge)
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('answers 400 for a create challenge presented to step-up', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)
    const issued = await issuePasskeyChallenge('create', { userId: session.userId })

    const response = await stepUpVerify(
      session.token,
      issued.challengeId,
      authenticator.assertionResponse(issued.challenge)
    )

    expect(response.status).toBe(400)
  })

  it('refuses a step-up challenge at sign-in and at registration', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)
    const first = await stepUpOptions(session.token)
    const signInResponse = await request(app)
      .post(`${BASE}/sign-in/verify`)
      .send({
        app: 'web',
        challengeId: envelope(first).data.challengeId,
        response: authenticator.assertionResponse(envelope(first).data.options.challenge),
      })
    const second = await stepUpOptions(session.token)
    const created = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({
        app: 'web',
        challengeId: envelope(second).data.challengeId,
        response: new SoftwareAuthenticator().registrationResponse(
          envelope(second).data.options.challenge
        ),
      })

    expect(signInResponse.status).toBe(400)
    expect(envelope(signInResponse).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(signInResponse.headers['set-cookie']).toBeUndefined()
    expect(created.status).toBe(400)
  })

  it('answers 400 when user verification is missing', async () => {
    const authenticator = new SoftwareAuthenticator()
    const session = await customerWithPasskey(authenticator)

    const response = await stepUp(session, (challenge) =>
      authenticator.assertionResponse(challenge, { isUserVerified: false })
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('refuses a device-bound passkey whose counter does not rise, and accepts a synced one at 0', async () => {
    const bound = new SoftwareAuthenticator({ backupEligible: false })
    const boundSession = await customerWithPasskey(bound)
    const rise = await stepUp(boundSession, (c) => bound.assertionResponse(c, { signCount: 5 }))
    const repeat = await stepUp(boundSession, (c) => bound.assertionResponse(c, { signCount: 5 }))
    const synced = new SoftwareAuthenticator()
    const syncedSession = await customerWithPasskey(synced)
    const first = await stepUp(syncedSession, (c) => synced.assertionResponse(c))
    const again = await stepUp(syncedSession, (c) => synced.assertionResponse(c))

    expect(rise.status).toBe(200)
    expect(repeat.status).toBe(400)
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
  })

  it('answers 401 with no bearer', async () => {
    const response = await request(app)
      .post(`${BASE}/step-up/verify`)
      .send({ challengeId: 'x', response: {} })

    expect(response.status).toBe(401)
  })

  it('answers the unknown-route 404 in mode off', async () => {
    mode.current = 'off'
    const session = await signIn(newEmail())

    const response = await request(app)
      .post(`${BASE}/step-up/verify`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({})

    expect(response.status).toBe(404)
  })
})
