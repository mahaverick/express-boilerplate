/**
 * @file `/api/v1/profile` against the real per-worker Postgres database
 * (tests/helpers/worker-database.ts). Each user gets a unique email and is
 * deleted in afterEach. Requests sign a token with `signAccessToken` instead
 * of logging in, since these tests cover what happens after authentication.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()

/**
 * The JSON `null` the API returns for an unset firstName or lastName;
 * `toEqual` must match that value, and `undefined` would not.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_NAME = null

/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string

/**
 * The envelope `response.utilities.ts` wraps every controller response in,
 * narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * The body of a profile response, as `toProfileResponse` in user.presenter.ts builds it.
 */
interface PublicUserBody {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  createdAt: string
  platformRole: string | null
  analyticsOptOut: boolean
}

/**
 * Casts a response body, which supertest types as `any`, to the envelope, so
 * every later property access is type-checked.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `profile-api-${randomUUID()}@example.test`
}

describe('/api/v1/profile', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Creates a user, tracks it for deletion in afterEach, and signs it an
   * access token with a random session id.
   */
  async function createAuthenticatedUser(
    overrides: Partial<{ email: string; passwordHash: string }> = {}
  ): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail(), ...overrides })
    createdIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  describe('GET /api/v1/profile', () => {
    it('returns the authenticated user and no password field of any kind', async () => {
      const { user, token } = await createAuthenticatedUser()

      const response = await request(app)
        .get('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      // toEqual, not toMatchObject: a leaked passwordHash or any other unexpected column must fail.
      expect(envelopeOf<PublicUserBody>(response).data).toEqual({
        id: user.id,
        email: user.email,
        firstName: NO_NAME,
        lastName: NO_NAME,
        createdAt: ANY_STRING,
        platformRole: NO_NAME,
        analyticsOptOut: false,
      })
      expect(JSON.stringify(response.body)).not.toMatch(/password/i)
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).get('/api/v1/profile')

      expect(response.status).toBe(401)
      expect(envelopeOf<PublicUserBody>(response).success).toBe(false)
    })

    // getProfile loads the user again after requireAuth did, and answers 404 when that second lookup finds nothing.
    it('returns 404 when the user is deleted between requireAuth loading it and the handler loading it again', async () => {
      const { token } = await createAuthenticatedUser()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realFindById = UserRepository.prototype.findById
      let callCount = 0
      /**
       * Passes the first lookup, requireAuth's, to the real method and finds nothing after that.
       */
      const mutatedFindById: typeof realFindById = function (this: UserRepository, id, options) {
        callCount += 1
        return callCount === 1 ? realFindById.call(this, id, options) : Promise.resolve(undefined)
      }

      await withMutatedMethod(UserRepository.prototype, 'findById', mutatedFindById, async () => {
        const response = await request(app)
          .get('/api/v1/profile')
          .set('Authorization', `Bearer ${token}`)

        expect(response.status).toBe(404)
        expect(envelopeOf<PublicUserBody>(response).success).toBe(false)
      })
    })
  })

  describe('PATCH /api/v1/profile', () => {
    it('updates the permitted fields and returns the updated user', async () => {
      const { user, token } = await createAuthenticatedUser()

      const response = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Ada', lastName: 'Lovelace' })

      expect(response.status).toBe(200)
      expect(envelopeOf<PublicUserBody>(response).data).toEqual({
        id: user.id,
        email: user.email,
        firstName: 'Ada',
        lastName: 'Lovelace',
        createdAt: ANY_STRING,
        platformRole: NO_NAME,
        analyticsOptOut: false,
      })

      const [row] = await sql`select first_name, last_name from users where id = ${user.id}`
      expect(row).toEqual({ first_name: 'Ada', last_name: 'Lovelace' })
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).patch('/api/v1/profile').send({ firstName: 'Ada' })

      expect(response.status).toBe(401)
    })

    // The same race on the write path: requireAuth never calls UserRepository.update, so mutating it unconditionally cannot fail an earlier lookup.
    it('returns 404 from an update when the user is deleted first', async () => {
      const { token } = await createAuthenticatedUser()

      await withMutatedMethod(
        UserRepository.prototype,
        'update',
        () => Promise.resolve(undefined),
        async () => {
          const response = await request(app)
            .patch('/api/v1/profile')
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: 'Ada' })

          expect(response.status).toBe(404)
        }
      )
    })

    it('treats an explicit null as clearing a field, distinct from omitting it', async () => {
      const { user, token } = await createAuthenticatedUser()
      await userRepository.update(user.id, { firstName: 'Ada', lastName: 'Lovelace' })

      // An omitted lastName is left alone and an explicit null firstName is cleared; the two assertions fail if they collapse into one behaviour.
      const response = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        // eslint-disable-next-line unicorn/no-null -- exercising the explicit-null-clears-the-field contract itself
        .send({ firstName: null })

      expect(response.status).toBe(200)
      expect(envelopeOf<PublicUserBody>(response).data).toMatchObject({
        firstName: NO_NAME,
        lastName: 'Lovelace',
      })
    })

    it('turns browser analytics off and on again, leaving the names alone', async () => {
      const { user, token } = await createAuthenticatedUser()
      await userRepository.update(user.id, { firstName: 'Ada' })

      const optedOut = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ analyticsOptOut: true })

      expect(optedOut.status).toBe(200)
      expect(envelopeOf<PublicUserBody>(optedOut).data).toMatchObject({
        firstName: 'Ada',
        analyticsOptOut: true,
      })
      const [stored] = await sql`select analytics_opt_out from users where id = ${user.id}`
      expect(stored).toEqual({ analytics_opt_out: true })

      const fetched = await request(app)
        .get('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
      expect(envelopeOf<PublicUserBody>(fetched).data?.analyticsOptOut).toBe(true)

      const optedIn = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ analyticsOptOut: false })
      expect(envelopeOf<PublicUserBody>(optedIn).data?.analyticsOptOut).toBe(false)
    })

    it.each([
      ['a string', 'yes'],
      ['null', NO_NAME],
      ['a number', 1],
    ])('refuses an analyticsOptOut that is %s, writing nothing', async (_label, value) => {
      const { user, token } = await createAuthenticatedUser()

      const response = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ analyticsOptOut: value })

      expect(response.status).toBe(400)
      const [stored] = await sql`select analytics_opt_out from users where id = ${user.id}`
      expect(stored).toEqual({ analytics_opt_out: false })
    })

    // Mass assignment: a filtered response can still hide a write, so the row is read back with raw SQL, independent of the repository under test.
    it('ignores email, id, passwordHash, and active even when supplied, and the stored row proves it', async () => {
      const originalPasswordHash = await hashPassword('OriginalPassword123!')
      const { user, token } = await createAuthenticatedUser({
        passwordHash: originalPasswordHash,
      })
      const attackerId = randomUUID()
      const attackerEmail = uniqueEmail()

      const response = await request(app)
        .patch('/api/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Updated',
          email: attackerEmail,
          id: attackerId,
          passwordHash: 'attacker-controlled-hash',
          active: false,
        })

      expect(response.status).toBe(200)
      const body = envelopeOf<PublicUserBody>(response).data
      // The legitimate field took effect, so the unchanged row below is not just a rejected request.
      expect(body?.firstName).toBe('Updated')
      expect(body?.id).toBe(user.id)
      expect(body?.email).toBe(user.email)

      const [row] = await sql`
        select id, email, password_hash, active, first_name
        from users
        where id = ${user.id}
      `
      expect(row).toEqual({
        id: user.id,
        email: user.email,
        password_hash: originalPasswordHash,
        active: true,
        first_name: 'Updated',
      })

      const attackerRow = await sql`select id from users where id = ${attackerId}`
      expect(attackerRow).toHaveLength(0)
    })
  })
})
