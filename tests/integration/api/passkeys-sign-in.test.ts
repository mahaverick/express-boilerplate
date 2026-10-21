/**
 * @file Signing in with a passkey under `/api/v1/auth/passkeys/sign-in`. A
 * software authenticator makes real registration and assertion responses, so
 * `@simplewebauthn/server` verifies every signature for real. Covers the
 * session (cookie, recent `auth_time`), the `user_signed_in` event, the stored
 * use, every refusal (unknown, inactive, deleted, never verified, non-staff on Apex, wrong origin, no user
 * verification, wrong-purpose and replayed challenges, counter regression),
 * the maintenance mode and the Apex staff rule.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { UserPasskeyRepository } from '@/repositories/user-passkey.repository'
import { sql } from '@/services/database.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { issuePasskeyChallenge } from '@/services/passkey-challenge.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { SoftwareAuthenticator, type AssertionJson } from '../../helpers/passkey-authenticator'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
} from '../../helpers/platform-users'
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

beforeEach(async () => {
  mode.current = 'optional'
  await clearRateLimiter('passkey-sign-in')
  await clearRateLimiter('passkey-sign-in-options')
  await clearRateLimiter('passkey-manage')
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  await sql`delete from email_messages where recipient like 'pu-%@example.test'`
  await deleteTrackedUsers()
})

/**
 * The response envelope, with the fields these tests read.
 */
interface Envelope {
  message: string
  code: string
  data: {
    challengeId: string
    options: { challenge: string; allowCredentials: unknown[]; userVerification: string }
    user: { id: string }
    accessToken: string
    isNewUser: boolean
    redirect: string | null
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
 * The user's WebAuthn user handle: their UUID's 16 bytes, base64url.
 * @param user - The user.
 * @returns The handle.
 */
function handleOf(user: User): string {
  return Buffer.from(user.id.replaceAll('-', ''), 'hex').toString('base64url')
}

/**
 * A user who holds one passkey made through the real registration route.
 * @param authenticator - The software authenticator to register.
 * @param options - How to build the user.
 * @param options.active - Whether the user is active.
 * @returns The user.
 */
async function userWithPasskey(
  authenticator: SoftwareAuthenticator,
  options: { active?: boolean } = {}
): Promise<User> {
  const user = await createTrackedUser(options)
  const token = recentAuthTokenFor(user)
  const asked = await request(app)
    .post(`${BASE}/registration/options`)
    .set('Authorization', `Bearer ${token}`)
    .send({ app: 'web' })
  const created = await request(app)
    .post(`${BASE}/registration/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      app: 'web',
      challengeId: envelope(asked).data.challengeId,
      response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
    })
  expect(created.status).toBe(201)
  return user
}

/**
 * Ask for sign-in options.
 * @returns The response.
 */
async function signInOptions() {
  return request(app).post(`${BASE}/sign-in/options`).send({})
}

/**
 * Sign in: ask for options, then post the authenticator's assertion.
 * @param make - Builds the assertion from the challenge.
 * @param app_ - The frontend.
 * @returns The verify response.
 */
async function signIn(make: (challenge: string) => AssertionJson, app_: 'web' | 'apex' = 'web') {
  const asked = await signInOptions()
  expect(asked.status).toBe(200)
  return request(app)
    .post(`${BASE}/sign-in/verify`)
    .send({
      app: app_,
      challengeId: envelope(asked).data.challengeId,
      response: make(envelope(asked).data.options.challenge),
    })
}

/**
 * The stored row of a user's only passkey.
 * @param userId - The owner.
 * @returns The sign count, last-used time and backup state.
 */
async function storedUse(userId: string) {
  const [row] = await sql<{ signCount: number; lastUsedAt: Date | null; backupState: boolean }[]>`
    select sign_count::int as "signCount", last_used_at as "lastUsedAt", backup_state as "backupState"
    from user_passkeys where user_id = ${userId}`
  if (!row) throw new Error('no passkey row')
  return row
}

/**
 * The `auth_time` claim of an access token, in seconds.
 * @param token - The JWT.
 * @returns The claim.
 */
function authTimeOf(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.', 2)[1] ?? '', 'base64url').toString()) as {
    auth_time: number
  }
  return payload.auth_time
}

describe('POST /sign-in/options', () => {
  it('answers a challenge and options that name no credential and require user verification', async () => {
    const response = await signInOptions()

    expect(response.status).toBe(200)
    expect(envelope(response).data.challengeId).toEqual(expect.any(String))
    expect(envelope(response).data.options.allowCredentials).toEqual([])
    expect(envelope(response).data.options.userVerification).toBe('required')
  })

  it('refuses a body that names an account', async () => {
    const response = await request(app).post(`${BASE}/sign-in/options`).send({ email: 'a@b.test' })

    expect(response.status).toBe(400)
  })
})

describe('POST /sign-in/verify', () => {
  it('issues the cookie and a recent access token, in the link verify shape', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)

    const before = Math.floor(Date.now() / 1000)
    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { userHandle: handleOf(user) })
    )

    expect(response.status).toBe(200)
    expect(envelope(response).message).toBe('Signed in.')
    const { data } = envelope(response)
    expect(data.user.id).toBe(user.id)
    expect(data.accessToken).toEqual(expect.any(String))
    expect(data.isNewUser).toBe(false)
    expect(data.redirect).toBeNull()
    expect(response.headers['cache-control']).toBe('no-store')
    expect(String(response.headers['set-cookie'])).toContain('=')
    expect(authTimeOf(envelope(response).data.accessToken)).toBeGreaterThanOrEqual(before - 1)
    const [row] = await sql<{ lastLoggedInAt: Date | null }[]>`
      select last_logged_in_at as "lastLoggedInAt" from users where id = ${user.id}`
    expect(row?.lastLoggedInAt).not.toBeNull()
  })

  it('updates last_used_at and sign_count', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: false })
    const user = await userWithPasskey(authenticator)

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { signCount: 7 })
    )

    expect(response.status).toBe(200)
    const use = await storedUse(user.id)
    expect(use.signCount).toBe(7)
    expect(use.lastUsedAt).not.toBeNull()
  })

  it('answers 400 PASSKEY_UNKNOWN, with no cookie, for a credential no account holds', async () => {
    const stranger = new SoftwareAuthenticator()

    const response = await signIn((challenge) => stranger.assertionResponse(challenge))

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_UNKNOWN')
    expect(envelope(response).message).toBe(
      "This passkey isn't linked to an account here. Sign in with an email link, then create a new passkey in Security settings."
    )
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('answers 403 PASSKEY_NO_ACCESS, with no cookie, for a deactivated user with a valid assertion', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set active = false where id = ${user.id}`

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))

    expect(response.status).toBe(403)
    expect(envelope(response).code).toBe('PASSKEY_NO_ACCESS')
    expect(envelope(response).message).toBe(
      "This passkey can't sign you in here. Sign in with an email link instead."
    )
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED for a bad signature on an inactive account, so the signature is checked first', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set active = false where id = ${user.id}`

    const response = await signIn((challenge) => {
      const good = authenticator.assertionResponse(challenge)
      return { ...good, response: { ...good.response, signature: 'AAAA' } }
    })

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('answers 403 PASSKEY_NO_ACCESS, with no cookie, for a user whose address was never verified', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set email_verified_at = null where id = ${user.id}`

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))

    expect(response.status).toBe(403)
    expect(envelope(response).code).toBe('PASSKEY_NO_ACCESS')
    expect(envelope(response).message).toBe(
      "This passkey can't sign you in here. Sign in with an email link instead."
    )
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it("drops a squatter's passkeys when a sign-in link claims the account, and the passkey then signs nobody in", async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set email_verified_at = null where id = ${user.id}`

    const claimed = await signInByLink(user.email, 'web')

    expect(claimed.userId).toBe(user.id)
    const rows = await sql`select 1 from user_passkeys where user_id = ${user.id}`
    expect(rows).toHaveLength(0)
    await clearRateLimiter('passkey-sign-in')
    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))
    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_UNKNOWN')
  })

  it('answers 400 PASSKEY_UNKNOWN, with no cookie, when a claim deletes the passkey after it verified', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    const repository = new UserPasskeyRepository()
    const lookup = repository.findByCredentialId.bind(repository)
    let response: Awaited<ReturnType<typeof signIn>> | undefined

    // The seam: the row is read, then a claim deletes it, before the session transaction runs.
    await withMutatedMethod(
      UserPasskeyRepository.prototype,
      'findByCredentialId',
      async (...arguments_: Parameters<typeof lookup>) => {
        const row = await lookup(...arguments_)
        await sql`delete from user_passkeys where user_id = ${user.id}`
        return row
      },
      async () => {
        response = await signIn((challenge) => authenticator.assertionResponse(challenge))
      }
    )

    expect(response?.status).toBe(400)
    expect(response === undefined ? '' : envelope(response).code).toBe('PASSKEY_UNKNOWN')
    expect(response?.headers['set-cookie']).toBeUndefined()
  })

  it('answers 403 PASSKEY_NO_ACCESS, with no cookie, for a soft-deleted user', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set deleted_at = now() where id = ${user.id}`

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))

    expect(response.status).toBe(403)
    expect(envelope(response).code).toBe('PASSKEY_NO_ACCESS')
    expect(envelope(response).message).toBe(
      "This passkey can't sign you in here. Sign in with an email link instead."
    )
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED for a wrong origin', async () => {
    const authenticator = new SoftwareAuthenticator()
    await userWithPasskey(authenticator)

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { origin: 'https://evil.example' })
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED when user verification is missing', async () => {
    const authenticator = new SoftwareAuthenticator()
    await userWithPasskey(authenticator)

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { isUserVerified: false })
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED for another user handle', async () => {
    const authenticator = new SoftwareAuthenticator()
    await userWithPasskey(authenticator)
    const other = await createTrackedUser()

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { userHandle: handleOf(other) })
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('answers 400 for a challenge of another purpose', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    const stepUp = await issuePasskeyChallenge('step_up', { userId: user.id })

    const response = await request(app)
      .post(`${BASE}/sign-in/verify`)
      .send({
        app: 'web',
        challengeId: stepUp.challengeId,
        response: authenticator.assertionResponse(stepUp.challenge),
      })

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('answers 400 for a challenge used twice', async () => {
    const authenticator = new SoftwareAuthenticator()
    await userWithPasskey(authenticator)
    const asked = await signInOptions()
    const body = {
      app: 'web',
      challengeId: envelope(asked).data.challengeId,
      response: authenticator.assertionResponse(envelope(asked).data.options.challenge),
    }

    const first = await request(app).post(`${BASE}/sign-in/verify`).send(body)
    const second = await request(app).post(`${BASE}/sign-in/verify`).send(body)

    expect([first.status, second.status]).toEqual([200, 400])
    expect(envelope(second).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('refuses a counter regression on a device-bound passkey', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: false })
    const user = await userWithPasskey(authenticator)
    await sql`update user_passkeys set sign_count = 5 where user_id = ${user.id}`

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { signCount: 5 })
    )

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(response.headers['set-cookie']).toBeUndefined()
    const use = await storedUse(user.id)
    expect(use.signCount).toBe(5)
  })

  it('lets exactly one of two parallel sign-ins with the same count succeed on a device-bound passkey', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: false })
    const user = await userWithPasskey(authenticator)
    await sql`update user_passkeys set sign_count = 5 where user_id = ${user.id}`

    const responses = await Promise.all([
      signIn((challenge) => authenticator.assertionResponse(challenge, { signCount: 6 })),
      signIn((challenge) => authenticator.assertionResponse(challenge, { signCount: 6 })),
    ])

    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 400,
    ])
    const refused = responses.find((response) => response.status === 400)
    expect(refused === undefined ? '' : envelope(refused).code).toBe('PASSKEY_VERIFICATION_FAILED')
    const use = await storedUse(user.id)
    expect(use.signCount).toBe(6)
  })

  it('accepts a device-bound passkey whose count rises', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: false })
    const user = await userWithPasskey(authenticator)
    await sql`update user_passkeys set sign_count = 5 where user_id = ${user.id}`

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { signCount: 6 })
    )

    expect(response.status).toBe(200)
    const use = await storedUse(user.id)
    expect(use.signCount).toBe(6)
  })

  it('does not refuse a synced passkey that reports count 0 after a stored count', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: true })
    const user = await userWithPasskey(authenticator)
    await sql`update user_passkeys set sign_count = 5 where user_id = ${user.id}`

    const response = await signIn((challenge) =>
      authenticator.assertionResponse(challenge, { signCount: 0 })
    )

    expect(response.status).toBe(200)
    const use = await storedUse(user.id)
    expect(use.signCount).toBe(0)
  })

  it('accepts a synced passkey at count 0', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: true })
    await userWithPasskey(authenticator)

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))

    expect(response.status).toBe(200)
  })

  it('refuses a non-staff account in full maintenance, 503 MAINTENANCE_MODE, writing nothing', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await storeMaintenanceMode('full', { message: 'Back at noon.' })
    await reloadMaintenanceMode()

    const asked = await signInOptions()
    const response = await request(app)
      .post(`${BASE}/sign-in/verify`)
      .send({
        app: 'web',
        challengeId: envelope(asked).data.challengeId,
        response: authenticator.assertionResponse(envelope(asked).data.options.challenge),
      })

    expect(asked.status).toBe(200)
    expect(response.status).toBe(503)
    expect(envelope(response).code).toBe('MAINTENANCE_MODE')
    expect(response.headers['set-cookie']).toBeUndefined()
    const use = await storedUse(user.id)
    expect(use.lastUsedAt).toBeNull()
  })

  it('admits staff in full maintenance', async () => {
    const authenticator = new SoftwareAuthenticator()
    const { user } = await createTrackedStaff('viewer')
    const token = recentAuthTokenFor(user)
    const asked = await request(app)
      .post(`${BASE}/registration/options`)
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'apex' })
    await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        app: 'apex',
        challengeId: envelope(asked).data.challengeId,
        response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
      })
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge), 'apex')

    expect(response.status).toBe(200)
  })

  it('refuses a non-staff account on apex with 403 PASSKEY_NO_ACCESS', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge), 'apex')

    expect(response.status).toBe(403)
    expect(envelope(response).code).toBe('PASSKEY_NO_ACCESS')
    expect(envelope(response).message).toBe(
      "This account doesn't have staff access. Ask a staff owner to invite you."
    )
    expect(response.headers['set-cookie']).toBeUndefined()
    const use = await storedUse(user.id)
    expect(use.lastUsedAt).toBeNull()
  })

  it('keeps the generic PASSKEY_NO_ACCESS message for a deactivated account on apex', async () => {
    const authenticator = new SoftwareAuthenticator()
    const user = await userWithPasskey(authenticator)
    await sql`update users set active = false where id = ${user.id}`

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge), 'apex')

    expect(response.status).toBe(403)
    expect(envelope(response).code).toBe('PASSKEY_NO_ACCESS')
    expect(envelope(response).message).toBe(
      "This passkey can't sign you in here. Sign in with an email link instead."
    )
  })

  it('keeps the options budget apart from the verify budget', async () => {
    const authenticator = new SoftwareAuthenticator()
    await userWithPasskey(authenticator)
    await clearRateLimiter('passkey-sign-in-options')
    for (let index = 0; index < 25; index += 1) {
      const asked = await signInOptions()
      expect(asked.status).toBe(200)
    }

    const response = await signIn((challenge) => authenticator.assertionResponse(challenge))

    expect(response.status).toBe(200)
  })

  it('refuses an origin that is not allowed before the limiter runs', async () => {
    const response = await request(app)
      .post(`${BASE}/sign-in/options`)
      .set('Origin', 'https://evil.example')
      .send({})

    expect(response.status).toBe(403)
  })
})

describe('mode off', () => {
  it('answers the unknown-route 404 on both routes', async () => {
    mode.current = 'off'

    const options = await signInOptions()
    const verify = await request(app).post(`${BASE}/sign-in/verify`).send({})

    expect([options.status, verify.status]).toEqual([404, 404])
  })
})
