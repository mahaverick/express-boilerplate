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
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { hashPassword } from '@/utilities/password.utilities'
import { issueToken } from '@/utilities/token.utilities'

const app = createApp()
const userRepository = new UserRepository()

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
