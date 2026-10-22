/**
 * @file The signed-in user's passkeys under `/api/v1/auth/passkeys`: list,
 * create (options then verify), rename and delete. A software authenticator
 * makes real registration responses, so `@simplewebauthn/server` verifies them
 * for real. The mode is switched by mocking `getEnv`, never `process.env`; the
 * mail is read off the `addEmailJob` call.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { addEmailJob } from '@/jobs/email.job'
import { sql } from '@/services/database.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { SoftwareAuthenticator, TEST_AAGUID_UNKNOWN } from '../../helpers/passkey-authenticator'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
  staleAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { clearRateLimiter } from '../../helpers/sign-in'

const mode = vi.hoisted(() => ({ current: 'optional' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), PASSKEY_MODE: mode.current }) }
})

vi.mock('@/jobs/email.job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/jobs/email.job')>()
  return { ...actual, addEmailJob: vi.fn(actual.addEmailJob) }
})

const app = createApp()
const BASE = '/api/v1/auth/passkeys'

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * The addresses this file made, for `afterEach` to clear mail rows for.
 */
const usedEmails: string[] = []

beforeEach(async () => {
  mode.current = 'optional'
  await clearRateLimiter('passkey-manage')
})

afterEach(async () => {
  await truncateAuditLogs()
  vi.mocked(addEmailJob).mockClear()
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * A tracked user with a first name.
 * @returns The user.
 */
async function makeUser(): Promise<User> {
  const user = await createTrackedUser({ firstName: 'Ada' })
  usedEmails.push(user.email.toLowerCase())
  return user
}

/**
 * One passkey as the API answers it.
 */
interface PasskeyJson {
  id: string
  name: string
  synced: boolean
  provider: { name: string }
  lastUsedAt: string | undefined
}

/**
 * The response envelope, with the fields these tests read.
 */
interface Envelope {
  message: string
  code: string
  errors: Record<string, string[]>
  data: {
    passkey: PasskeyJson
    passkeys: PasskeyJson[]
    userHandle: string
    challengeId: string
    options: { challenge: string }
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
 * Ask for registration options.
 * @param token - The bearer token.
 * @returns The response.
 */
async function options(token: string) {
  return request(app)
    .post(`${BASE}/registration/options`)
    .set('Authorization', `Bearer ${token}`)
    .send({ app: 'web' })
}

/**
 * Create a passkey end to end with `authenticator`.
 * @param token - The bearer token.
 * @param authenticator - The software authenticator.
 * @returns The verify response.
 */
async function createPasskey(token: string, authenticator: SoftwareAuthenticator) {
  const asked = await options(token)
  expect(asked.status).toBe(200)
  return request(app)
    .post(`${BASE}/registration/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      app: 'web',
      challengeId: envelope(asked).data.challengeId,
      response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
    })
}

describe('creating and listing passkeys', () => {
  it('creates a passkey, then lists it with the provider name and synced flag', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const authenticator = new SoftwareAuthenticator()

    const created = await createPasskey(token, authenticator)
    const listed = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)

    expect(created.status).toBe(201)
    expect(envelope(created).message).toBe('Passkey created.')
    expect(envelope(created).data.passkey).toMatchObject({
      name: 'Apple Passwords',
      synced: true,
      provider: { name: 'Apple Passwords' },
      lastUsedAt: null,
    })
    expect(envelope(created).data.passkey).toMatchObject({
      credentialId: authenticator.credentialId,
    })
    expect(listed.status).toBe(200)
    expect(envelope(listed).message).toBe('Passkeys retrieved.')
    expect(envelope(listed).data.passkeys).toEqual([envelope(created).data.passkey])
    expect(envelope(listed).data.userHandle).toBe(
      Buffer.from(user.id.replaceAll('-', ''), 'hex').toString('base64url')
    )
  })

  it('shapes the options: resident key, user verification, no attestation, the user handle and the exclude list', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const first = new SoftwareAuthenticator()
    await createPasskey(token, first)

    const asked = await options(token)
    const body = envelope(asked).data.options as unknown as {
      attestation: string
      authenticatorSelection: { residentKey: string; userVerification: string }
      user: { id: string; name: string; displayName: string }
      excludeCredentials: { id: string }[]
    }

    expect(body.attestation).toBe('none')
    expect(body.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(body.user.id).toBe(Buffer.from(user.id.replaceAll('-', ''), 'hex').toString('base64url'))
    expect(body.user.name).toBe(user.email)
    expect(body.user.displayName).toBe('Ada')
    expect(body.excludeCredentials.map((credential) => credential.id)).toEqual([first.credentialId])
  })

  it('records the audit row on the platform tenant without the credential ID', async () => {
    const user = await makeUser()
    const authenticator = new SoftwareAuthenticator()

    const created = await createPasskey(recentAuthTokenFor(user), authenticator)

    const platform = await platformTenant()
    const rows = await sql<{ tenant_id: string; target_id: string; metadata: unknown }[]>`
      select tenant_id, target_id, metadata from audit_logs where action = 'user.passkey_created'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tenant_id).toBe(platform.id)
    expect(rows[0]?.target_id).toBe(user.id)
    expect(rows[0]?.metadata).toEqual({
      passkeyId: envelope(created).data.passkey.id,
      provider: 'Apple Passwords',
      app: 'web',
    })
    expect(JSON.stringify(rows[0])).not.toContain(authenticator.credentialId)
  })

  it('queues the passkey_created mail to the user', async () => {
    const user = await makeUser()

    await createPasskey(recentAuthTokenFor(user), new SoftwareAuthenticator())

    expect(addEmailJob).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email.toLowerCase(),
        templateKey: 'passkey_created',
        variables: expect.objectContaining({
          firstName: 'Ada',
          providerName: 'Apple Passwords',
        }) as unknown,
      }),
      user.id,
      { context: { linkApp: 'web' } }
    )
  })

  it('names a second passkey from the same provider "<name> 2", then "<name> 3"', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)

    const names: string[] = []
    for (let created = 0; created < 3; created += 1) {
      const response = await createPasskey(token, new SoftwareAuthenticator())
      names.push(envelope(response).data.passkey.name)
    }

    expect(names).toEqual(['Apple Passwords', 'Apple Passwords 2', 'Apple Passwords 3'])
  })

  it('names a passkey from an unlisted authenticator "Passkey"', async () => {
    const user = await makeUser()

    const created = await createPasskey(
      recentAuthTokenFor(user),
      new SoftwareAuthenticator({ aaguid: TEST_AAGUID_UNKNOWN, backupEligible: false })
    )

    expect(envelope(created).data.passkey).toMatchObject({ name: 'Passkey', synced: false })
  })

  it('answers 409 PASSKEY_LIMIT at 20 passkeys, on options and on verify', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const pending = await options(token)
    for (let index = 0; index < 20; index += 1) {
      await sql`
        insert into user_passkeys (user_id, credential_id, public_key, aaguid, backup_eligible, backup_state, name)
        values (${user.id}, ${`filler-${String(index)}`}, ${Buffer.from('k')}, ${TEST_AAGUID_UNKNOWN}, false, false, ${`Filler ${String(index)}`})
      `
    }

    const refusedOptions = await options(token)
    const refusedVerify = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        app: 'web',
        challengeId: envelope(pending).data.challengeId,
        response: new SoftwareAuthenticator().registrationResponse(
          envelope(pending).data.options.challenge
        ),
      })

    for (const refused of [refusedOptions, refusedVerify]) {
      expect(refused.status).toBe(409)
      expect(envelope(refused).code).toBe('PASSKEY_LIMIT')
      expect(envelope(refused).message).toBe(
        'You have 20 passkeys, the limit for one account. Delete one to create another.'
      )
    }
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED when the user was not verified', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const asked = await options(token)

    const response = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        app: 'web',
        challengeId: envelope(asked).data.challengeId,
        response: new SoftwareAuthenticator().registrationResponse(
          envelope(asked).data.options.challenge,
          { isUserVerified: false }
        ),
      })

    expect(response.status).toBe(400)
    expect(envelope(response).code).toBe('PASSKEY_VERIFICATION_FAILED')
    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from user_passkeys where user_id = ${user.id}
    `
    expect(row?.total).toBe(0)
  })

  it('answers 403 EMAIL_UNVERIFIED on options, and on verify once the address is no longer verified', async () => {
    const user = await createTrackedUser({ verified: false })
    usedEmails.push(user.email.toLowerCase())
    const token = recentAuthTokenFor(user)
    const verified = await createTrackedUser()
    usedEmails.push(verified.email.toLowerCase())
    const asked = await options(recentAuthTokenFor(verified))

    const refusedOptions = await options(token)
    // A challenge issued while the address was verified, spent after it was lost: the lock still refuses.
    await sql`update users set email_verified_at = null where id = ${verified.id}`
    const lost = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(verified)}`)
      .send({
        app: 'web',
        challengeId: envelope(asked).data.challengeId,
        response: new SoftwareAuthenticator().registrationResponse(
          envelope(asked).data.options.challenge
        ),
      })

    expect(refusedOptions.status).toBe(403)
    expect(envelope(refusedOptions).code).toBe('EMAIL_UNVERIFIED')
    expect(lost.status).toBe(403)
    expect(envelope(lost).code).toBe('EMAIL_UNVERIFIED')
    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from user_passkeys where user_id = ${verified.id}
    `
    expect(row?.total).toBe(0)
  })

  it('answers 409 for a credential another user holds, and stores and audits nothing', async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const authenticator = new SoftwareAuthenticator()
    await createPasskey(recentAuthTokenFor(owner), authenticator)

    const duplicate = await createPasskey(recentAuthTokenFor(other), authenticator)

    expect(duplicate.status).toBe(409)
    expect(envelope(duplicate).message).toBe('This passkey is already saved. Create a new one.')
    const [rows] = await sql<{ total: number }[]>`
      select count(*)::int as total from user_passkeys where user_id = ${other.id}
    `
    const [audits] = await sql<{ total: number }[]>`
      select count(*)::int as total from audit_logs where target_id = ${other.id}
    `
    expect(rows?.total).toBe(0)
    expect(audits?.total).toBe(0)
  })

  it('drops transports WebAuthn does not define, keeping order and removing repeats', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const asked = await options(token)
    const registration = new SoftwareAuthenticator().registrationResponse(
      envelope(asked).data.options.challenge
    )
    registration.response.transports = ['usb', 'bogus', 'usb', 'internal']

    const response = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'web', challengeId: envelope(asked).data.challengeId, response: registration })

    expect(response.status).toBe(201)
    const [row] = await sql<{ transports: string[] }[]>`
      select transports from user_passkeys where user_id = ${user.id}
    `
    expect(row?.transports).toEqual(['usb', 'internal'])
  })
})

describe('refusals while creating', () => {
  it('answers 401 REAUTH_REQUIRED on options, verify and delete when the sign-in is stale', async () => {
    const user = await makeUser()
    const stale = staleAuthTokenFor(user)
    const created = await createPasskey(recentAuthTokenFor(user), new SoftwareAuthenticator())

    const responses = await Promise.all([
      request(app)
        .post(`${BASE}/registration/options`)
        .set('Authorization', `Bearer ${stale}`)
        .send({ app: 'web' }),
      request(app)
        .post(`${BASE}/registration/verify`)
        .set('Authorization', `Bearer ${stale}`)
        .send({ app: 'web', challengeId: 'x', response: {} }),
      request(app)
        .delete(`${BASE}/${envelope(created).data.passkey.id}`)
        .set('Authorization', `Bearer ${stale}`),
    ])

    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(envelope(response).code).toBe(REAUTH_REQUIRED_CODE)
    }
  })

  it('spends no passkey-manage budget on a REAUTH_REQUIRED refusal', async () => {
    const user = await makeUser()
    const stale = staleAuthTokenFor(user)
    const refused = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post(`${BASE}/registration/options`)
          .set('Authorization', `Bearer ${stale}`)
          .send({ app: 'web' })
      )
    )

    const allowed = await options(recentAuthTokenFor(user))

    expect(refused.every((response) => response.status === 401)).toBe(true)
    expect(allowed.status).toBe(200)
  })

  it('answers 400 PASSKEY_VERIFICATION_FAILED for a replayed challengeId', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const asked = await options(token)
    /**
     * Send the verify call with `authenticator`'s response to the one challenge.
     * @param authenticator - The software authenticator.
     * @returns The response.
     */
    const send = async (authenticator: SoftwareAuthenticator) =>
      request(app)
        .post(`${BASE}/registration/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          app: 'web',
          challengeId: envelope(asked).data.challengeId,
          response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
        })

    const first = await send(new SoftwareAuthenticator())
    const replay = await send(new SoftwareAuthenticator())

    expect(first.status).toBe(201)
    expect(replay.status).toBe(400)
    expect(envelope(replay).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(envelope(replay).message).toBe(
      "We couldn't confirm this passkey. Try again, or use another method."
    )
  })

  it("refuses another user's challenge and a response signed for another origin", async () => {
    const user = await makeUser()
    const other = await makeUser()
    const asked = await options(recentAuthTokenFor(user))
    const authenticator = new SoftwareAuthenticator()

    const crossUser = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(other)}`)
      .send({
        app: 'web',
        challengeId: envelope(asked).data.challengeId,
        response: authenticator.registrationResponse(envelope(asked).data.options.challenge),
      })
    const second = await options(recentAuthTokenFor(user))
    const wrongOrigin = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(user)}`)
      .send({
        app: 'web',
        challengeId: envelope(second).data.challengeId,
        response: authenticator.registrationResponse(envelope(second).data.options.challenge, {
          origin: 'https://evil.example',
        }),
      })

    expect(crossUser.status).toBe(400)
    expect(envelope(crossUser).code).toBe('PASSKEY_VERIFICATION_FAILED')
    expect(wrongOrigin.status).toBe(400)
    expect(envelope(wrongOrigin).code).toBe('PASSKEY_VERIFICATION_FAILED')
  })

  it('refuses a body without a response with a field error', async () => {
    const user = await makeUser()

    const response = await request(app)
      .post(`${BASE}/registration/verify`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(user)}`)
      .send({ app: 'web', challengeId: 'x' })

    expect(response.status).toBe(400)
    expect(envelope(response).errors).toHaveProperty('response')
  })

  it('answers 401 without a sign-in', async () => {
    const response = await request(app).get(BASE)

    expect(response.status).toBe(401)
  })
})

describe('renaming', () => {
  it('renames a passkey and answers it', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const created = await createPasskey(token, new SoftwareAuthenticator())

    const renamed = await request(app)
      .patch(`${BASE}/${envelope(created).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  Work laptop  ' })

    expect(renamed.status).toBe(200)
    expect(envelope(renamed).message).toBe('Passkey renamed.')
    expect(envelope(renamed).data.passkey.name).toBe('Work laptop')
  })

  it('answers 400 with a field error for a 65-character name', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const created = await createPasskey(token, new SoftwareAuthenticator())

    const renamed = await request(app)
      .patch(`${BASE}/${envelope(created).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x'.repeat(65) })
    const blank = await request(app)
      .patch(`${BASE}/${envelope(created).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: ' '.repeat(3) })

    expect(renamed.status).toBe(400)
    expect(envelope(renamed).errors).toHaveProperty('name')
    expect(blank.status).toBe(400)
    expect(envelope(blank).errors).toHaveProperty('name')
  })

  it("answers the passkey 404 for another user's passkey, on PATCH and DELETE", async () => {
    const owner = await makeUser()
    const intruder = await makeUser()
    const created = await createPasskey(recentAuthTokenFor(owner), new SoftwareAuthenticator())
    const id = envelope(created).data.passkey.id
    const token = recentAuthTokenFor(intruder)

    const patch = await request(app)
      .patch(`${BASE}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mine now' })
    const remove = await request(app)
      .delete(`${BASE}/${id}`)
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app)
      .delete(`${BASE}/does-not-exist`)
      .set('Authorization', `Bearer ${token}`)

    for (const response of [patch, remove, unknown]) {
      expect(response.status).toBe(404)
      expect(envelope(response).code).toBe('passkey_not_found')
    }
    const [row] = await sql<{ name: string }[]>`select name from user_passkeys where id = ${id}`
    expect(row?.name).toBe('Apple Passwords')
  })
})

describe('deleting', () => {
  it('deletes a passkey, answers the remaining list, audits and mails', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const first = await createPasskey(token, new SoftwareAuthenticator())
    const second = await createPasskey(token, new SoftwareAuthenticator())
    vi.mocked(addEmailJob).mockClear()

    const removed = await request(app)
      .delete(`${BASE}/${envelope(first).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(removed.status).toBe(200)
    expect(envelope(removed).message).toBe('Passkey deleted.')
    expect(envelope(removed).data.passkeys).toEqual([envelope(second).data.passkey])
    expect(envelope(removed).data.userHandle).toBe(
      Buffer.from(user.id.replaceAll('-', ''), 'hex').toString('base64url')
    )
    const rows = await sql<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_logs where action = 'user.passkey_deleted'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata).toMatchObject({
      passkeyId: envelope(first).data.passkey.id,
      provider: 'Apple Passwords',
      app: 'web',
    })
    expect(addEmailJob).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'passkey_deleted' }),
      user.id,
      { context: { linkApp: 'web' } }
    )
  })

  it('in required mode deletes the second passkey, then refuses the last with LAST_PASSKEY', async () => {
    mode.current = 'required'
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const first = await createPasskey(token, new SoftwareAuthenticator())
    const second = await createPasskey(token, new SoftwareAuthenticator())

    const removed = await request(app)
      .delete(`${BASE}/${envelope(second).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)
    const refused = await request(app)
      .delete(`${BASE}/${envelope(first).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(removed.status).toBe(200)
    expect(refused.status).toBe(409)
    expect(envelope(refused).code).toBe('LAST_PASSKEY')
    expect(envelope(refused).message).toBe(
      'Create another passkey before you delete this one. Your account needs at least one.'
    )
    const listed = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
    expect(envelope(listed).data.passkeys).toHaveLength(1)
  })

  it('in required mode, two deletes at once leave one passkey: one 200 and one LAST_PASSKEY', async () => {
    mode.current = 'required'
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const first = await createPasskey(token, new SoftwareAuthenticator())
    const second = await createPasskey(token, new SoftwareAuthenticator())

    const responses = await Promise.all(
      [first, second].map(async (created) =>
        request(app)
          .delete(`${BASE}/${envelope(created).data.passkey.id}`)
          .set('Authorization', `Bearer ${token}`)
      )
    )

    expect(
      responses.map((response) => response.status).toSorted((left, right) => left - right)
    ).toEqual([200, 409])
    const refused = responses.find((response) => response.status === 409)
    expect(refused && envelope(refused).code).toBe('LAST_PASSKEY')
    const listed = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
    expect(envelope(listed).data.passkeys).toHaveLength(1)
  })

  it('in optional mode deletes the last passkey', async () => {
    const user = await makeUser()
    const token = recentAuthTokenFor(user)
    const only = await createPasskey(token, new SoftwareAuthenticator())

    const removed = await request(app)
      .delete(`${BASE}/${envelope(only).data.passkey.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(removed.status).toBe(200)
    expect(envelope(removed).data.passkeys).toEqual([])
  })
})

describe('mode off', () => {
  it('answers the unknown-route 404 on every management route', async () => {
    mode.current = 'off'
    const user = await makeUser()
    const token = recentAuthTokenFor(user)

    const responses = await Promise.all([
      request(app).get(BASE).set('Authorization', `Bearer ${token}`),
      request(app)
        .post(`${BASE}/registration/options`)
        .set('Authorization', `Bearer ${token}`)
        .send({ app: 'web' }),
      request(app).delete(`${BASE}/x`).set('Authorization', `Bearer ${token}`),
    ])

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(envelope(response).code).toBe('not_found')
    }
  })
})
