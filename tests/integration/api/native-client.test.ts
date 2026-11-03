/**
 * @file A native app's session, end to end. Every request sends
 * `X-Client: native`: each sign-in answers the refresh token in its body and
 * sets no cookie, and refresh, logout, revoke-others and step-up read the
 * token from the body only, never a cookie. Google sign-in refuses a native
 * request before anything else runs. The env mock turns passkeys and Google
 * on for this file only.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, sql } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import { hashToken, rotateRefreshToken, verifyAccessToken } from '@/services/session.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { isTokenRowLive } from '../../helpers/grace-sibling'
import { SoftwareAuthenticator } from '../../helpers/passkey-authenticator'
import {
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { clearRateLimiter, issueTestLink, signInByLink } from '../../helpers/sign-in'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      PASSKEY_MODE: 'optional',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    }),
  }
})

const app = createApp()
const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()

const HEX_TOKEN = /^[0-9a-f]{64}$/

/**
 * Every address this file signed in by link, for `afterEach` to delete.
 */
const usedEmails: string[] = []

/**
 * Every tenant this file created, for `afterEach` to delete.
 */
const createdTenantIds: string[] = []

beforeEach(async () => {
  await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
  await clearRateLimiter(RATE_LIMITS.refresh.name)
  await clearRateLimiter(RATE_LIMITS.googleOAuth.name)
  await clearRateLimiter(RATE_LIMITS.googleOAuthCallback.name)
  await clearRateLimiter('passkey-sign-in')
  await clearRateLimiter('passkey-sign-in-options')
  await clearRateLimiter('passkey-manage')
})

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (usedEmails.length > 0) {
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * The `data` of a native sign-in or refresh: the access token and the
 * refresh token the body carries.
 */
interface TokenData {
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: string
  user: { id: string }
}

/**
 * Read a response's `data` as a native token answer.
 * @param response - The response.
 * @returns Its `data`.
 */
function tokenData(response: Response): TokenData {
  return (response.body as { data: TokenData }).data
}

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test, for reading rows while debugging.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `native-client-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * Sign in as a native app by a fresh link.
 * @param email - The address to sign in as.
 * @param body - Extra body fields, such as a refresh token to present.
 * @returns The verify response.
 */
async function nativeLinkVerify(email: string, body: object = {}): Promise<Response> {
  const token = await issueTestLink(email)
  await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
  return request(app)
    .post('/api/v1/auth/link/verify')
    .set('X-Client', 'native')
    .send({ token, email, ...body })
}

/**
 * Sign in as a native app and read the session off the body.
 * @param email - The address to sign in as.
 * @returns The access token, the raw refresh token, the user's id and the session id.
 * @throws {Error} When the verify does not answer 200.
 */
async function nativeSignIn(
  email: string
): Promise<{ accessToken: string; refreshToken: string; userId: string; sid: string }> {
  const response = await nativeLinkVerify(email)
  if (response.status !== 200) throw new Error(`nativeSignIn: verify answered ${response.status}`)
  const data = tokenData(response)
  const verified = verifyAccessToken(data.accessToken)
  if (!verified.ok || verified.payload.sid === undefined) throw new Error('nativeSignIn: no sid')
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userId: data.user.id,
    sid: verified.payload.sid,
  }
}

/**
 * Whether the response set any cookie.
 * @param response - The response.
 * @returns True when a `Set-Cookie` header is present.
 */
function hasSetCookie(response: Response): boolean {
  return response.headers['set-cookie'] !== undefined
}

/**
 * Split a native session's chain into the owner's live token and a grace
 * sibling: rotate the first token, then replay it at once.
 * @param raw - The session's first raw refresh token.
 * @returns The owner's token and the sibling's.
 */
async function splitNativeChain(raw: string): Promise<{ ownerRaw: string; siblingRaw: string }> {
  const owner = await rotateRefreshToken(raw, 'native')
  const sibling = await rotateRefreshToken(raw, 'native')
  if (sibling.sessionId !== owner.sessionId) throw new Error('the replay did not mint a sibling')
  return { ownerRaw: owner.raw, siblingRaw: sibling.raw }
}

/**
 * Whether rotating a native token carries a confirmation from the last half
 * hour, where the test aged the session an hour back.
 * @param raw - The raw refresh token.
 * @returns True when the rotation carries a recent time.
 */
async function hasRecentTimeAfterRotating(raw: string): Promise<boolean> {
  const rotated = await rotateRefreshToken(raw, 'native')
  return (rotated.authenticatedAt?.getTime() ?? 0) > Date.now() - 30 * 60 * 1000
}

/**
 * A customer tenant with a pending invitation for `email` and a live
 * confirm link, written past the API.
 * @param email - The invited address.
 * @returns The tenant and the confirm link's raw token.
 */
async function invitedWithLink(email: string): Promise<{ tenant: Tenant; raw: string }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `native-client-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'editor',
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      tx
    )
  )
  const { raw } = await issueLinkToken(
    { intent: 'invitation', email, app: 'web', invitationId: invitation.id },
    requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  )
  return { tenant, raw }
}

/**
 * A user who holds one passkey, registered through the real routes.
 * @param authenticator - The software authenticator to register.
 * @returns The user.
 */
async function userWithPasskey(authenticator: SoftwareAuthenticator): Promise<User> {
  const user = await createTrackedUser()
  const bearer = recentAuthTokenFor(user)
  const asked = await request(app)
    .post('/api/v1/auth/passkeys/registration/options')
    .set('Authorization', `Bearer ${bearer}`)
    .send({ app: 'web' })
  const { challengeId, options } = (
    asked.body as { data: { challengeId: string; options: { challenge: string } } }
  ).data
  const created = await request(app)
    .post('/api/v1/auth/passkeys/registration/verify')
    .set('Authorization', `Bearer ${bearer}`)
    .send({
      app: 'web',
      challengeId,
      response: authenticator.registrationResponse(options.challenge),
    })
  expect(created.status).toBe(201)
  return user
}

describe('a native client', () => {
  it('link verify returns refreshToken in the body and no Set-Cookie', async () => {
    const response = await nativeLinkVerify(uniqueEmail('verify'))

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(hasSetCookie(response)).toBe(false)
    const data = tokenData(response)
    expect(data.refreshToken).toMatch(HEX_TOKEN)
    expect(new Date(data.refreshTokenExpiresAt).toISOString()).toBe(data.refreshTokenExpiresAt)
    expect(new Date(data.refreshTokenExpiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(await isTokenRowLive(data.refreshToken)).toBe(true)
  })

  it('refresh rotates a body token and returns the next one', async () => {
    const session = await nativeSignIn(uniqueEmail('refresh'))

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .send({ refreshToken: session.refreshToken })

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(hasSetCookie(response)).toBe(false)
    const data = tokenData(response)
    expect(data.accessToken).toEqual(expect.any(String))
    expect(data.refreshToken).toMatch(HEX_TOKEN)
    expect(data.refreshToken).not.toBe(session.refreshToken)
    expect(await isTokenRowLive(session.refreshToken)).toBe(false)
    expect(await isTokenRowLive(data.refreshToken)).toBe(true)
  })

  it('stores the device name at sign-in and ignores the header on refresh', async () => {
    const email = uniqueEmail('device')
    const token = await issueTestLink(email)
    await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
    const signIn = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('X-Client', 'native')
      .set('X-Device-Name', 'iPhone 16')
      .send({ token, email })
    expect(signIn.status).toBe(200)

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .set('X-Device-Name', 'Evil')
      .send({ refreshToken: tokenData(signIn).refreshToken })

    expect(refreshed.status).toBe(200)
    const rows = await sql<{ device_name: string | null }[]>`
      select device_name from user_tokens
      where token_hash = ${hashToken(tokenData(refreshed).refreshToken)}`
    expect(rows.map((row) => row.device_name)).toEqual(['iPhone 16'])
  })

  it('signs in with no device name when the header is over 64 characters', async () => {
    const email = uniqueEmail('long-device')
    const token = await issueTestLink(email)
    await clearRateLimiter(RATE_LIMITS.signInLinkVerify.name)
    const signIn = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('X-Client', 'native')
      .set('X-Device-Name', 'a'.repeat(65))
      .send({ token, email })

    expect(signIn.status).toBe(200)
    const rows = await sql<{ device_name: string | null }[]>`
      select device_name from user_tokens
      where token_hash = ${hashToken(tokenData(signIn).refreshToken)}`
    expect(rows.map((row) => row.device_name)).toEqual([null])
  })

  it('refresh ignores a cookie on a native request', async () => {
    const web = await signInByLink(uniqueEmail('web-cookie'))
    const webRaw = decodeURIComponent(web.refreshCookie.slice(web.refreshCookie.indexOf('=') + 1))
    const native = await nativeSignIn(uniqueEmail('native-body'))

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .set('Cookie', web.refreshCookie)
      .send({ refreshToken: native.refreshToken })

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(false)
    expect(await isTokenRowLive(native.refreshToken)).toBe(false)
    expect(await isTokenRowLive(webRaw)).toBe(true)
  })

  it('refresh with only a cookie answers 401 and reads no cookie', async () => {
    const web = await signInByLink(uniqueEmail('cookie-only'))
    const webRaw = decodeURIComponent(web.refreshCookie.slice(web.refreshCookie.indexOf('=') + 1))

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .set('Cookie', web.refreshCookie)
      .send({})

    expect(response.status).toBe(401)
    expect(hasSetCookie(response)).toBe(false)
    expect(await isTokenRowLive(webRaw)).toBe(true)
  })

  it('logout with a body token revokes that session', async () => {
    const session = await nativeSignIn(uniqueEmail('logout'))

    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Client', 'native')
      .send({ refreshToken: session.refreshToken })

    expect(response.status).toBe(200)
    expect((response.body as { message: string }).message).toBe('Signed out.')
    expect(hasSetCookie(response)).toBe(false)
    expect(await isTokenRowLive(session.refreshToken)).toBe(false)
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .send({ refreshToken: session.refreshToken })
    expect(refreshed.status).toBe(401)
  })

  it('passkey sign-in verify returns a body token', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    const asked = await request(app)
      .post('/api/v1/auth/passkeys/sign-in/options')
      .set('X-Client', 'native')
      .send({})
    const { challengeId, options } = (
      asked.body as { data: { challengeId: string; options: { challenge: string } } }
    ).data

    const response = await request(app)
      .post('/api/v1/auth/passkeys/sign-in/verify')
      .set('X-Client', 'native')
      .send({
        app: 'web',
        challengeId,
        response: authenticator.assertionResponse(options.challenge),
      })

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(false)
    const data = tokenData(response)
    expect(data.user.id).toBe(user.id)
    expect(data.refreshToken).toMatch(HEX_TOKEN)
    expect(await isTokenRowLive(data.refreshToken)).toBe(true)
  })

  it('invitation confirm returns a body token', async () => {
    const email = uniqueEmail('confirm')
    const { tenant, raw } = await invitedWithLink(email)

    const response = await request(app)
      .post('/api/v1/invitations/confirm')
      .set('X-Client', 'native')
      .send({ token: raw, email })

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(false)
    const data = tokenData(response) as TokenData & { tenant: { slug: string } }
    expect(data.tenant.slug).toBe(tenant.slug)
    expect(data.refreshToken).toMatch(HEX_TOKEN)
    expect(await isTokenRowLive(data.refreshToken)).toBe(true)
  })

  it('a new sign-in with the old body token revokes the old session', async () => {
    const email = uniqueEmail('resign-in')
    const old = await nativeSignIn(email)

    const response = await nativeLinkVerify(email, { refreshToken: old.refreshToken })

    expect(response.status).toBe(200)
    expect(await isTokenRowLive(old.refreshToken)).toBe(false)
    expect(await isTokenRowLive(tokenData(response).refreshToken)).toBe(true)
  })

  it('revoke-others with a body token spares only the presented chain', async () => {
    const email = uniqueEmail('revoke-others')
    const caller = await nativeSignIn(email)
    const { ownerRaw, siblingRaw } = await splitNativeChain(caller.refreshToken)
    const other = await nativeSignIn(email)

    const response = await request(app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set('X-Client', 'native')
      .set('Authorization', `Bearer ${caller.accessToken}`)
      .send({ refreshToken: ownerRaw })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ success: true, data: { revoked: 1 } })
    expect(await isTokenRowLive(ownerRaw)).toBe(true)
    expect(await isTokenRowLive(siblingRaw)).toBe(false)
    expect(await isTokenRowLive(other.refreshToken)).toBe(false)
  })

  it('step-up link verify with a body token marks only the presented row', async () => {
    const email = uniqueEmail('step-up')
    const session = await nativeSignIn(email)
    const { ownerRaw, siblingRaw } = await splitNativeChain(session.refreshToken)
    await sql`
      update user_tokens set authenticated_at = authenticated_at - interval '1 hour'
      where session_id = ${session.sid} and purpose = 'refresh'
    `
    const { raw: linkToken } = await issueLinkToken(
      { intent: 'step_up', userId: session.userId, sessionId: session.sid, email, app: 'web' },
      requireDurationMs(getEnv().STEP_UP_LINK_TTL)
    )

    const response = await request(app)
      .post('/api/v1/auth/step-up/link/verify')
      .set('X-Client', 'native')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ token: linkToken, refreshToken: ownerRaw })

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(false)
    expect(await hasRecentTimeAfterRotating(siblingRaw)).toBe(false)
    expect(await hasRecentTimeAfterRotating(ownerRaw)).toBe(true)
  })

  it('Google start and callback answer 400 NATIVE_CLIENT_REFUSED', async () => {
    // A browser's start redirects, so the routes are mounted under this file's env.
    const web = await request(app).get('/api/v1/auth/google')
    expect(web.status).toBe(302)

    for (const path of ['/api/v1/auth/google', '/api/v1/auth/google/callback']) {
      const response = await request(app).get(path).set('X-Client', 'native')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'NATIVE_CLIENT_REFUSED',
        message:
          "Google sign-in isn't available in the app yet. Sign in with an email link or a passkey.",
      })
      // Before the limiter and the OAuth session: no budget spent and no session cookie.
      expect(response.headers['ratelimit-remaining']).toBeUndefined()
      expect(hasSetCookie(response)).toBe(false)
    }
  })
})

/**
 * Post one native refresh with the given raw token.
 * @param raw - The raw refresh token to present in the body.
 * @returns The refresh response.
 */
function nativeRefresh(raw: string): Promise<Response> {
  return request(app)
    .post('/api/v1/auth/refresh')
    .set('X-Client', 'native')
    .send({ refreshToken: raw })
}

/**
 * The refresh limiter keys a native request by its token, so one device
 * behind a shared address cannot spend another's budget.
 */
describe('the native refresh limit', () => {
  it('keeps two tokens from one IP on separate budgets', async () => {
    const session = await nativeSignIn(uniqueEmail('limit-native'))
    const spent = randomBytes(32).toString('hex')

    for (let attempt = 0; attempt < RATE_LIMITS.refresh.limit; attempt += 1) {
      const response = await nativeRefresh(spent)
      if (response.status === 429) throw new Error(`limited early, at attempt ${String(attempt)}`)
    }
    const refused = await nativeRefresh(spent)
    expect(refused.status).toBe(429)

    const other = await nativeRefresh(session.refreshToken)
    expect(other.status).toBe(200)
  })

  it('answers a native refresh with no body token 401 and counts it against the IP', async () => {
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'native')
      .send({})
    expect(response.status).toBe(401)
    expect(response.headers['ratelimit-remaining']).toBe(String(RATE_LIMITS.refresh.limit - 1))
  })

  it('still shares one budget across web refreshes from one IP', async () => {
    for (let attempt = 0; attempt < RATE_LIMITS.refresh.limit; attempt += 1) {
      const response = await request(app).post('/api/v1/auth/refresh')
      if (response.status === 429) throw new Error(`limited early, at attempt ${String(attempt)}`)
    }
    const refused = await request(app).post('/api/v1/auth/refresh')
    expect(refused.status).toBe(429)
  })
})

/**
 * The same handlers for a browser: the token stays in the cookie and the
 * body names it nowhere.
 */
describe('a browser client', () => {
  it('link verify sets the cookie and adds no token fields to the body', async () => {
    const token = await issueTestLink(uniqueEmail('web-verify'))
    const email = usedEmails.at(-1) ?? ''

    const response = await request(app).post('/api/v1/auth/link/verify').send({ token, email })

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(true)
    expect(Object.keys((response.body as { data: object }).data).toSorted()).toEqual([
      'accessToken',
      'isNewUser',
      'redirect',
      'user',
    ])
  })

  it('refresh answers only the access token', async () => {
    const web = await signInByLink(uniqueEmail('web-refresh'))

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', web.refreshCookie)

    expect(response.status).toBe(200)
    expect(hasSetCookie(response)).toBe(true)
    expect(Object.keys((response.body as { data: object }).data)).toEqual(['accessToken'])
  })
})
