/**
 * @file `POST /api/v1/auth/step-up/link/request` and `/step-up/link/verify`:
 * a staff member confirms it is them by an emailed link bound to the session
 * that asked. The link moves that session's `authenticated_at` and answers a
 * fresh access token; another session of the same user, another user, a used,
 * expired or unknown link, and a link whose session signed out are refused
 * with one `LINK_INVALID`, and a refusal never spends the link. Staff sign in
 * by a real link (`signInByLink`), since the confirm marks the refresh rows of
 * the token's `sid`. The mail is read off the `addEmailJob` call, not
 * delivered.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE, LINK_INVALID_CODE } from '@/constants/auth.constants'
import { addEmailJob } from '@/jobs/email.job'
import { sql } from '@/services/database.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { verifyAccessToken } from '@/services/session.service'
import { confirmStepUpLink } from '@/services/step-up.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'

vi.mock('@/jobs/email.job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/email.job')>()
  return { ...actual, addEmailJob: vi.fn(actual.addEmailJob) }
})

const app = createApp()

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * One signed-in staff session: the user, its address, the bearer token, the
 * session id in it and the refresh cookie.
 */
interface StaffSession {
  userId: string
  email: string
  token: string
  sid: string
  refreshCookie: string
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
 * End a user's step-up mail cooldown, so the next request mails again.
 * @param userId - The user.
 */
async function clearCooldown(userId: string): Promise<void> {
  const redis = await getRedis()
  await redis.del(redisKey('step-up-link', userId))
}

/**
 * Every address this file signed in, for `afterEach` to delete.
 */
const usedEmails: string[] = []

beforeEach(async () => {
  await clearRateLimiter('sign-in-link-verify')
})

afterEach(async () => {
  await truncateAuditLogs()
  vi.mocked(addEmailJob).mockClear()
  if (usedEmails.length === 0) return
  await sql`delete from email_messages where recipient = any(${usedEmails})`
  await sql`delete from users where email = any(${usedEmails})`
  usedEmails.length = 0
})

/**
 * A verified staff account for a fresh address.
 * @returns The address.
 */
async function createStaff(): Promise<string> {
  const email = `step-up-link-${randomUUID()}@example.test`
  usedEmails.push(email)
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, email_verified_at) values (${email}, now()) returning id
  `
  if (!user) throw new Error('createStaff: no row')
  await makeStaff(user.id, 'viewer')
  return email
}

/**
 * Sign a staff address in to Apex by a real link: a new session each call.
 * @param email - The staff address.
 * @returns The session.
 */
async function signIn(email: string): Promise<StaffSession> {
  const session = await signInByLink(email, 'apex')
  const { sid } = claims(session.accessToken)
  if (sid === undefined) throw new Error('the sign-in issued a token without sid')
  return {
    userId: session.userId,
    email,
    token: session.accessToken,
    sid,
    refreshCookie: session.refreshCookie,
  }
}

/**
 * Ask for a step-up link as one session.
 * @param token - The session's bearer token.
 * @returns The response.
 */
function requestLink(token: string): Promise<Response> {
  return request(app)
    .post('/api/v1/auth/step-up/link/request')
    .set('Authorization', `Bearer ${token}`)
    .send({})
}

/**
 * Confirm a step-up link as one session.
 * @param token - The bearer token presenting it, or undefined for none.
 * @param linkToken - The raw link token.
 * @returns The response.
 */
function verifyLink(token: string | undefined, linkToken: string): Promise<Response> {
  const pending = request(app).post('/api/v1/auth/step-up/link/verify')
  if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
  return pending.send({ token: linkToken })
}

/**
 * The confirm URL the last queued step-up mail carries.
 * @returns The URL.
 * @throws {Error} When no step-up mail was queued.
 */
function lastConfirmUrl(): URL {
  const call = vi
    .mocked(addEmailJob)
    .mock.calls.findLast(([message]) => message.templateKey === 'step_up_link')
  if (!call) throw new Error('no step_up_link mail was queued')
  const [message] = call
  if (message.templateKey !== 'step_up_link') throw new Error('unreachable')
  return new URL(message.variables.confirmUrl)
}

/**
 * Ask for a link as `session` and read its raw token off the queued mail.
 * @param session - The session asking.
 * @returns The raw link token.
 */
async function issueLink(session: StaffSession): Promise<string> {
  const response = await requestLink(session.token)
  expect(response.status).toBe(202)
  const token = lastConfirmUrl().searchParams.get('token')
  if (token === null) throw new Error('the confirm URL carries no token')
  return token
}

/**
 * The step-up link rows a user holds, oldest first.
 * @param userId - The user.
 * @returns The columns these tests read.
 */
async function linkRows(userId: string): Promise<
  {
    userId: string
    sessionId: string
    purpose: string
    consumed: boolean
    revoked: boolean
  }[]
> {
  return sql`
    select user_id as "userId", session_id as "sessionId", purpose,
      consumed_at is not null as consumed, revoked_at is not null as revoked
    from user_tokens where user_id = ${userId} and purpose = 'step_up_link'
    order by created_at, id
  `
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
 * The `authenticated_at` of a session's refresh rows, as epoch milliseconds.
 * @param sid - The session.
 * @returns One value per row.
 */
async function refreshAuthenticatedTimes(sid: string): Promise<number[]> {
  const rows = await sql<{ at: Date }[]>`
    select authenticated_at as at from user_tokens
    where session_id = ${sid} and purpose = 'refresh'
  `
  return rows.map((row) => new Date(row.at).getTime())
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

describe('POST /api/v1/auth/step-up/link/request', () => {
  it('mails an apex confirm link bound to the calling session', async () => {
    const session = await signIn(await createStaff())
    const before = Date.now()

    const response = await requestLink(session.token)

    expect(response.status).toBe(202)
    const { resendAvailableAt } = (response.body as { data: { resendAvailableAt: string } }).data
    const cooldownMs = requireDurationMs(getEnv().STEP_UP_LINK_COOLDOWN)
    expect(Date.parse(resendAvailableAt)).toBeGreaterThanOrEqual(before + cooldownMs - 1000)
    expect(Date.parse(resendAvailableAt)).toBeLessThanOrEqual(Date.now() + cooldownMs + 1000)
    expect(await linkRows(session.userId)).toEqual([
      {
        userId: session.userId,
        sessionId: session.sid,
        purpose: 'step_up_link',
        consumed: false,
        revoked: false,
      },
    ])
    const url = lastConfirmUrl()
    expect(url.pathname).toBe('/auth/confirm')
    expect(url.searchParams.get('token')).toMatch(/^[\w-]{43}$/)
    const [message, , options] = vi.mocked(addEmailJob).mock.calls.at(-1) ?? []
    expect(message?.to).toBe(session.email)
    expect(options?.context).toMatchObject({ linkApp: 'apex' })
  })

  it('answers 429 STEP_UP_LINK_COOLDOWN with Retry-After inside the cooldown', async () => {
    const session = await signIn(await createStaff())
    const first = await requestLink(session.token)
    expect(first.status).toBe(202)

    const response = await requestLink(session.token)

    expect(response.status).toBe(429)
    expect((response.body as { code?: string }).code).toBe('STEP_UP_LINK_COOLDOWN')
    const cooldownSeconds = requireDurationMs(getEnv().STEP_UP_LINK_COOLDOWN) / 1000
    const retryAfter = Number(response.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(cooldownSeconds)
    // The default 1m cooldown just began, so the wait reads in whole seconds or as 1 minute.
    expect((response.body as { message?: string }).message).toMatch(
      /^Check your inbox for the link we sent\. You can ask for another in (\d+ seconds|1 minute)\.$/
    )
    expect(await linkRows(session.userId)).toHaveLength(1)
  })

  it('asks a token without sid to refresh (401 ACCESS_TOKEN_EXPIRED)', async () => {
    const session = await signIn(await createStaff())
    const sidLess = jwt.sign({ sub: session.userId }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const response = await requestLink(sidLess)

    expect(response.status).toBe(401)
    expect((response.body as { code?: string }).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
    expect(await linkRows(session.userId)).toEqual([])
  })

  it('gives the cooldown back when the mail cannot be queued, so the next request mails', async () => {
    const session = await signIn(await createStaff())
    vi.mocked(addEmailJob).mockRejectedValueOnce(new Error('queue down'))

    const failed = await requestLink(session.token)

    expect(failed.status).toBe(500)
    const retried = await requestLink(session.token)
    expect(retried.status).toBe(202)
  })

  it('answers 401 with no bearer', async () => {
    const response = await request(app).post('/api/v1/auth/step-up/link/request').send({})

    expect(response.status).toBe(401)
  })
})

describe('POST /api/v1/auth/step-up/link/verify', () => {
  it('moves authenticated_at for the session and returns a fresh access token', async () => {
    const session = await signIn(await createStaff())
    await ageSession(session.sid)
    const linkToken = await issueLink(session)
    const before = Date.now()

    const response = await verifyLink(session.token, linkToken)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const fresh = claims((response.body as { data: { accessToken: string } }).data.accessToken)
    expect(fresh.sid).toBe(session.sid)
    expect(fresh.authTime).toBeGreaterThanOrEqual(Math.floor(before / 1000) - 1)
    expect(fresh.authTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    const times = await refreshAuthenticatedTimes(session.sid)
    expect(times.length).toBeGreaterThan(0)
    for (const time of times) expect(time).toBeGreaterThanOrEqual(before - 1000)
    const platform = await platformTenant()
    expect(await stepUpAudits(session.userId)).toEqual([
      { action: 'auth.step_up_confirmed', metadata: { method: 'link' }, tenantId: platform.id },
    ])
  })

  it('keeps the new time on the next refresh', async () => {
    const session = await signIn(await createStaff())
    await ageSession(session.sid)
    const confirmed = await verifyLink(session.token, await issueLink(session))
    const confirmedAt = claims(
      (confirmed.body as { data: { accessToken: string } }).data.accessToken
    ).authTime

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .send({})

    expect(refreshed.status).toBe(200)
    expect(
      claims((refreshed.body as { data: { accessToken: string } }).data.accessToken).authTime
    ).toBe(confirmedAt)
  })

  it('neither spends nor honours the link for another session of the same user', async () => {
    const email = await createStaff()
    const asking = await signIn(email)
    const other = await signIn(email)
    await ageSession(asking.sid)
    await ageSession(other.sid)
    const linkToken = await issueLink(asking)
    const otherTimesBefore = await refreshAuthenticatedTimes(other.sid)

    const refused = await verifyLink(other.token, linkToken)

    expect(refused.status).toBe(400)
    expect((refused.body as { code?: string }).code).toBe(LINK_INVALID_CODE)
    expect(await linkRows(asking.userId)).toMatchObject([{ consumed: false, revoked: false }])
    expect(await refreshAuthenticatedTimes(other.sid)).toEqual(otherTimesBefore)
    expect(await stepUpAudits(asking.userId)).toEqual([])

    const accepted = await verifyLink(asking.token, linkToken)

    expect(accepted.status).toBe(200)
    expect(await refreshAuthenticatedTimes(other.sid)).toEqual(otherTimesBefore)
  })

  it('neither spends nor honours the link for another user', async () => {
    const asking = await signIn(await createStaff())
    const stranger = await signIn(await createStaff())
    const linkToken = await issueLink(asking)

    const refused = await verifyLink(stranger.token, linkToken)

    expect(refused.status).toBe(400)
    expect((refused.body as { code?: string }).code).toBe(LINK_INVALID_CODE)
    expect(await linkRows(asking.userId)).toMatchObject([{ consumed: false }])
    const accepted = await verifyLink(asking.token, linkToken)
    expect(accepted.status).toBe(200)
  })

  it('answers LINK_INVALID for a used, expired or unknown link', async () => {
    const session = await signIn(await createStaff())
    const used = await issueLink(session)
    const spent = await verifyLink(session.token, used)
    expect(spent.status).toBe(200)
    await clearCooldown(session.userId)
    const expired = await issueLink(session)
    await sql`
      update user_tokens set expires_at = now() - interval '1 second'
      where user_id = ${session.userId} and purpose = 'step_up_link' and consumed_at is null
    `
    const unknown = randomBytes(32).toString('base64url')

    for (const linkToken of [used, expired, unknown]) {
      const response = await verifyLink(session.token, linkToken)
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        success: false,
        code: LINK_INVALID_CODE,
        message: 'This link has expired or was already used.',
      })
    }
    expect(await stepUpAudits(session.userId)).toEqual([
      expect.objectContaining({ action: 'auth.step_up_confirmed' }),
    ])
  })

  it('refuses the link once its session signed out', async () => {
    const session = await signIn(await createStaff())
    const linkToken = await issueLink(session)

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', session.refreshCookie)
      .send({})

    expect(logout.status).toBe(200)
    expect(await linkRows(session.userId)).toMatchObject([{ revoked: true, consumed: false }])
    // The sign-out denies the session's access tokens too, so requireAuth refuses before the link is read.
    const response = await verifyLink(session.token, linkToken)
    expect(response.status).toBe(401)
    expect(await linkRows(session.userId)).toMatchObject([{ revoked: true, consumed: false }])
    expect(await stepUpAudits(session.userId)).toEqual([])
  })

  it('asks a token without sid to refresh (401 ACCESS_TOKEN_EXPIRED), spending nothing', async () => {
    const session = await signIn(await createStaff())
    const linkToken = await issueLink(session)
    const sidLess = jwt.sign({ sub: session.userId }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    const response = await verifyLink(sidLess, linkToken)

    expect(response.status).toBe(401)
    expect((response.body as { code?: string }).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
    expect(await linkRows(session.userId)).toMatchObject([{ consumed: false }])
  })

  it('refuses a caller no longer staff at confirm time, leaving the link unspent', async () => {
    const session = await signIn(await createStaff())
    await ageSession(session.sid)
    const linkToken = await issueLink(session)
    const timesBefore = await refreshAuthenticatedTimes(session.sid)
    await sql`delete from user_memberships where user_id = ${session.userId}`

    // The service directly: over HTTP the route's role gate answers first, so this is the demotion that lands after the gate.
    await expect(confirmStepUpLink(session.userId, session.sid, linkToken)).rejects.toMatchObject({
      statusCode: 404,
    })

    expect(await refreshAuthenticatedTimes(session.sid)).toEqual(timesBefore)
    expect(await linkRows(session.userId)).toMatchObject([{ consumed: false, revoked: false }])
    expect(await stepUpAudits(session.userId)).toMatchObject([
      { action: 'auth.step_up_refused', metadata: { method: 'link' } },
    ])
    await makeStaff(session.userId, 'viewer')
    const restored = await verifyLink(session.token, linkToken)
    expect(restored.status).toBe(200)
  })

  it('rolls the claim back when the session ended before the confirm', async () => {
    const session = await signIn(await createStaff())
    const linkToken = await issueLink(session)
    await sql`
      update user_tokens set revoked_at = now()
      where session_id = ${session.sid} and purpose = 'refresh'
    `

    await expect(confirmStepUpLink(session.userId, session.sid, linkToken)).rejects.toMatchObject({
      statusCode: 401,
      code: ACCESS_TOKEN_EXPIRED_CODE,
    })

    expect(await linkRows(session.userId)).toMatchObject([{ consumed: false, revoked: false }])
    expect(await stepUpAudits(session.userId)).toEqual([])
  })

  it('answers 401 with no bearer', async () => {
    const session = await signIn(await createStaff())
    const linkToken = await issueLink(session)

    const response = await verifyLink(undefined, linkToken)

    expect(response.status).toBe(401)
    expect(await linkRows(session.userId)).toMatchObject([{ consumed: false }])
  })
})
