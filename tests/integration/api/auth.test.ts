// tests/integration/api/auth.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts) — every email used here is unique to
// this run (never a fixed literal) and every row created is deleted in
// afterEach, the same convention tests/integration/repositories/
// user.repository.test.ts and tests/integration/middlewares/
// auth.middleware.test.ts already follow. This file lives under
// tests/integration/, never tests/unit/, precisely because it does that —
// see CLAUDE.md's note on why a DB-dependent test under tests/unit/ breaks
// .husky/pre-commit whenever Docker is down.
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_BYTES,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from '@/constants/auth.constants'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import * as passwordUtilities from '@/utilities/password.utilities'

const app = createApp()
const userRepository = new UserRepository()

// A valid registration password everywhere it's needed as a fixture, not
// itself the thing under test — 8+ characters, comfortably under the byte
// ceiling.
const VALID_PASSWORD = 'correct horse battery staple'

// The API legitimately returns JSON `null` for an unset nullable column
// (firstName/lastName) — `toEqual` must match that exact value, and
// `undefined` would not. One disable, reused everywhere the shape is
// asserted, rather than one per occurrence.
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_NAME = null

// vitest types `expect.any(...)` as `any` (it's an asymmetric matcher, not
// a real string) — assigning it directly into an object literal's property
// trips @typescript-eslint/no-unsafe-assignment at every call site. The
// `as unknown as string` cast resolves that at the type level (the
// asymmetric matcher's actual runtime behaviour inside `toEqual` is
// unaffected) in exactly one place, reused everywhere a `toEqual` shape
// needs "any string here". The matcher carries no per-test state, so one
// shared instance is safe across every assertion below.
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
 * The public projection of a user row (auth.controller.ts's `PublicUser`).
 */
interface PublicUserBody {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  createdAt: string
}

/**
 * A login response's `data`.
 */
interface LoginBody {
  user: PublicUserBody
  accessToken: string
}

/**
 * Cast a supertest response's body to a known envelope shape. supertest
 * types `.body` as `any`; every access after this point is a normal,
 * type-checked property access rather than an unsafe one.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: request.Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-api-${randomUUID()}@example.test`
}

/**
 * Find the raw `Set-Cookie` line for the refresh-token cookie in a
 * supertest response, if one was set.
 * @param response - The supertest response.
 * @returns The raw `Set-Cookie` header value, or undefined if the cookie was not set.
 */
function findRefreshTokenCookie(response: request.Response): string | undefined {
  const cookieLines = response.headers['set-cookie'] as string[] | undefined
  return cookieLines?.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
}

/**
 * Log in through the real HTTP endpoint.
 * @param email - The email to log in with.
 * @param password - The password to log in with.
 * @returns The raw supertest response and its typed envelope.
 */
async function login(
  email: string,
  password: string
): Promise<{ response: request.Response; body: ApiEnvelope<LoginBody> }> {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password })
  return { response, body: envelopeOf<LoginBody>(response) }
}

describe('POST /api/v1/auth/register and /login', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Register a user through the real HTTP endpoint and track it for
   * cleanup.
   * @param overrides - Fields to override on the default registration body.
   * @returns The raw supertest response and its typed envelope.
   */
  async function registerUser(
    overrides: Partial<{
      email: string
      password: string
      firstName: string
      lastName: string
    }> = {}
  ): Promise<{ response: request.Response; body: ApiEnvelope<PublicUserBody> }> {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: VALID_PASSWORD, ...overrides })
    const body = envelopeOf<PublicUserBody>(response)
    if (response.status === 201 && body.data) createdIds.push(body.data.id)
    return { response, body }
  }

  describe('registration', () => {
    it('registers a user and returns no password field of any kind', async () => {
      const email = uniqueEmail()
      const { response, body } = await registerUser({ email })

      expect(response.status).toBe(201)
      // toEqual, not toMatchObject: a leaked passwordHash (or any other
      // unexpected column) slips past a subset match but must fail this
      // one — the exact-shape check is what makes this test fail if the
      // property regresses, not just if the field is renamed.
      expect(body.data).toEqual({
        id: ANY_STRING,
        email,
        firstName: NO_NAME,
        lastName: NO_NAME,
        createdAt: ANY_STRING,
      })
      expect(JSON.stringify(response.body)).not.toMatch(/password/i)
    })

    it('accepts optional firstName and lastName and returns them', async () => {
      const { response, body } = await registerUser({ firstName: 'Ada', lastName: 'Lovelace' })

      expect(response.status).toBe(201)
      expect(body.data).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' })
    })

    it('rejects a weak password with a field-level error', async () => {
      const { response, body } = await registerUser({ password: 'short1' })

      expect(response.status).toBe(400)
      expect(body.success).toBe(false)
      expect(body.errors?.password).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('rejects a password over the bcrypt byte limit as a validation error, not a 500', async () => {
      const { response, body } = await registerUser({
        password: 'a'.repeat(MAX_PASSWORD_BYTES + 1),
      })

      expect(response.status).toBe(400)
      expect(body.success).toBe(false)
      expect(body.errors?.password).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('rejects an email longer than the column can hold as a 400, not a 500', async () => {
      // Red before the .max() cap on emailSchema: validation passed, the
      // insert hit users.email's varchar(320) and Postgres answered 22001
      // (string data right truncation). That is not the unique violation
      // BaseRepository translates, so it propagated as an unexpected error
      // — a client error answered 500, and (before the redaction in
      // error.middleware.ts) logged with the address and bcrypt hash
      // attached.
      const domain = '@example.test'
      const overLong = `${'a'.repeat(MAX_EMAIL_LENGTH + 1 - domain.length)}${domain}`
      expect(overLong).toHaveLength(MAX_EMAIL_LENGTH + 1)

      const { response, body } = await registerUser({ email: overLong })

      expect(response.status).toBe(400)
      expect(body.errors?.email).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('accepts an email exactly at the column width', async () => {
      // The other side of the boundary: the cap must be the column's width,
      // not one short of it.
      const domain = '@example.test'
      const local = `${randomUUID()}${'a'.repeat(MAX_EMAIL_LENGTH - domain.length - 36)}`
      const exact = `${local}${domain}`
      expect(exact).toHaveLength(MAX_EMAIL_LENGTH)

      const { response } = await registerUser({ email: exact })

      expect(response.status).toBe(201)
    })

    it('rejects a malformed email address with a field-level error', async () => {
      const { response, body } = await registerUser({ email: 'not-an-email' })

      expect(response.status).toBe(400)
      expect(body.errors?.email).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('rejects a duplicate email with 409, not 500', async () => {
      const email = uniqueEmail()
      const first = await registerUser({ email })
      expect(first.response.status).toBe(201)

      const second = await registerUser({ email })
      expect(second.response.status).toBe(409)
      expect(second.body.success).toBe(false)
    })

    it('rejects a duplicate email that only differs by case, agreeing with the lower(email) unique index', async () => {
      const email = uniqueEmail()
      const first = await registerUser({ email })
      expect(first.response.status).toBe(201)

      const second = await registerUser({ email: email.toUpperCase() })
      expect(second.response.status).toBe(409)
    })

    it('normalises email case on registration, and the stored row agrees', async () => {
      const email = uniqueEmail()
      const mixedCase = `${email.slice(0, 1).toUpperCase()}${email.slice(1)}`.replace(
        '@example.test',
        '@EXAMPLE.test'
      )

      const { response, body } = await registerUser({ email: mixedCase })

      expect(response.status).toBe(201)
      expect(body.data?.email).toBe(mixedCase.toLowerCase())
      const userId = body.data?.id
      if (!userId) throw new Error('registration did not return an id')

      const [row] = await sql`select email from users where id = ${userId}`
      expect(row?.email).toBe(mixedCase.toLowerCase())
    })
  })

  describe('login', () => {
    it('logs in with correct credentials, returns an access token, and sets a refresh cookie', async () => {
      const email = uniqueEmail()
      await registerUser({ email })

      const { response, body } = await login(email, VALID_PASSWORD)

      expect(response.status).toBe(200)
      expect(body.data).toEqual({
        user: {
          id: ANY_STRING,
          email,
          firstName: NO_NAME,
          lastName: NO_NAME,
          createdAt: ANY_STRING,
        },
        accessToken: ANY_STRING,
      })
      expect(JSON.stringify(response.body)).not.toMatch(/passwordhash/i)

      const refreshCookie = findRefreshTokenCookie(response)
      expect(refreshCookie).toBeDefined()
      expect(refreshCookie).toMatch(/HttpOnly/i)
      expect(refreshCookie).toMatch(/SameSite=Strict/i)
      expect(refreshCookie).toContain(`Path=${REFRESH_TOKEN_COOKIE_PATH}`)
      // Not Secure under NODE_ENV=test — see
      // tests/unit/controllers/auth.controller.test.ts for the production
      // branch, which cannot be exercised here: getEnv() is memoised for
      // the life of the process once any module has called it.
      expect(refreshCookie).not.toMatch(/Secure/i)
    })

    it('gives the SAME error for an unknown email and a wrong password', async () => {
      const email = uniqueEmail()
      await registerUser({ email })
      const fixedRequestId = randomUUID()

      const unknownEmailResult = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Request-Id', fixedRequestId)
        .send({ email: uniqueEmail(), password: 'whatever-password-123' })

      const wrongPasswordResult = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Request-Id', fixedRequestId)
        .send({ email, password: 'definitely-the-wrong-password' })

      // Asserted together, not each in isolation: this is the only way to
      // pin that the two are indistinguishable rather than merely each
      // individually plausible.
      expect(unknownEmailResult.status).toBe(401)
      expect(unknownEmailResult.status).toBe(wrongPasswordResult.status)
      expect(unknownEmailResult.body).toEqual(wrongPasswordResult.body)
      expect(findRefreshTokenCookie(unknownEmailResult)).toBeUndefined()
      expect(findRefreshTokenCookie(wrongPasswordResult)).toBeUndefined()
    })

    it('runs a real password comparison for both an unknown email and a wrong password (timing-safety mechanism)', async () => {
      const email = uniqueEmail()
      await registerUser({ email })
      const passwordValidationSpy = vi.spyOn(passwordUtilities, 'isPasswordValid')

      await login(uniqueEmail(), 'whatever-password-123')
      await login(email, 'definitely-the-wrong-password')

      // Both paths pay bcrypt's cost — an unknown email is never answered
      // by skipping the comparison outright, which is what would otherwise
      // let a caller distinguish the two cases by response TIMING even
      // though the response BODY (asserted above) is identical.
      expect(passwordValidationSpy).toHaveBeenCalledTimes(2)
    })

    it('refuses login for a soft-deleted user, identically to an unknown email', async () => {
      const email = uniqueEmail()
      const { body } = await registerUser({ email })
      if (body.data) await userRepository.softDelete(body.data.id)

      const { response } = await login(email, VALID_PASSWORD)

      expect(response.status).toBe(401)
      expect(findRefreshTokenCookie(response)).toBeUndefined()
    })

    it('refuses login for a deactivated (active: false) user, through the same rejection', async () => {
      const email = uniqueEmail()
      const { body } = await registerUser({ email })
      if (body.data) await userRepository.update(body.data.id, { active: false })

      const { response } = await login(email, VALID_PASSWORD)

      expect(response.status).toBe(401)
      expect(findRefreshTokenCookie(response)).toBeUndefined()
    })

    it('refuses login for a user with no password set (a federated-identity user)', async () => {
      const email = uniqueEmail()
      const user = await userRepository.create({ email })
      createdIds.push(user.id)

      const { response } = await login(email, 'any-password-at-all-123')

      expect(response.status).toBe(401)
      expect(findRefreshTokenCookie(response)).toBeUndefined()
    })

    it('rejects a login request missing the password field with a validation error', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({ email: uniqueEmail() })
      const body = envelopeOf<LoginBody>(response)

      expect(response.status).toBe(400)
      expect(body.errors?.password).toEqual(expect.arrayContaining([expect.any(String)]))
    })
  })
})
