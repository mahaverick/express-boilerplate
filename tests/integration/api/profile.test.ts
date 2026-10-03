/**
 * @file Integration test against the real per-worker Postgres database
 * (see tests/helpers/worker-database.ts) — every email used here is
 * unique to this run and every row created is deleted in afterEach.
 * Authenticated requests sign a token directly with `signAccessToken`
 * rather than going through POST /api/v1/auth/login, since these tests
 * are about what happens after authentication, not about login itself.
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
 * The API legitimately returns JSON `null` for an unset nullable column
 * (firstName/lastName) — `toEqual` must match that exact value, and
 * `undefined` would not.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_NAME = null

/**
 * vitest types `expect.any(...)` as `any`; reused as one shared
 * instance across every assertion below.
 */
const ANY_STRING = expect.any(String) as unknown as string

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
 * The public projection of a user row (user.presenter.ts's `PublicUser`,
 * reused by profile.controller.ts).
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
 * Cast a supertest response's body to a known envelope shape. supertest
 * types `.body` as `any`; every access after this point is a normal,
 * type-checked property access rather than an unsafe one.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `profile-api-${randomUUID()}@example.test`
}

/**
 * Same convention tests/integration/api/auth.test.ts and
 * tests/integration/middlewares/auth.middleware.test.ts already
 * follow. This file lives under tests/integration/, never
 * tests/unit/ — see CLAUDE.md's note on why a DB-dependent test under
 * tests/unit/ breaks .husky/pre-commit whenever Docker is down.
 * Authenticated requests here mirror
 * tests/integration/middlewares/auth.middleware.test.ts's own
 * sign-a-token-directly approach.
 */
describe('/api/v1/profile', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Create a disposable user row, sign an access token for it, and track
   * the row for cleanup.
   * @param overrides - Column values to override on the created row.
   * @returns The created row and a valid bearer token for it.
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
      // toEqual, not toMatchObject: a leaked passwordHash (or any other unexpected column) slips past a subset match but must fail this one.
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

    // A real race: getProfile loads the user a second time after requireAuth already loaded it once, and 404s if that second lookup comes back empty.
    it('returns 404 when the user is deleted between requireAuth loading it and the handler loading it again', async () => {
      const { token } = await createAuthenticatedUser()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realFindById = UserRepository.prototype.findById
      let callCount = 0
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

    // The hasChanges branch of the same race the GET test above proves, here via UserRepository.update; unlike findById, requireAuth never calls update, so mutating it unconditionally cannot make an earlier lookup fail first.
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

      // lastName omitted entirely -> left alone; firstName explicit null -> cleared. If these collapsed to the same thing, one of the two assertions below would fail.
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

    // Mass-assignment protection: a request mixing a legitimate field change with fields this endpoint must never let a caller touch. Asserting only the response would not be enough (a filtered response can still hide a write underneath), so this reads the row back with raw SQL, independent of the repository under test.
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
      // The legitimate field in the same request did take effect — otherwise the test below would be trivially true of a request rejected outright.
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
