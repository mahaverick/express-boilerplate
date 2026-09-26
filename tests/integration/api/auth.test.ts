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
import type { Worker } from 'bullmq'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_BYTES } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import type { EmailJobData } from '@/jobs/email.job'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import * as passwordUtilities from '@/utilities/password.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import {
  deleteMailpitMessage,
  drainMailpit,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
import { withMutatedMethod } from '../../helpers/mutate'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()
const { name: REFRESH_TOKEN_COOKIE_NAME, path: REFRESH_TOKEN_COOKIE_PATH } = testRefreshCookie()

// register/resendVerification now enqueue via BullMQ (addNotificationJob for
// verification mail, addEmailJob directly for the registration-attempt
// notice) instead of calling sendMail() directly — nothing in this file's own
// request cycle ever processes those jobs, so without live Workers every
// `findMailpitMessages` assertion below would poll its budget and find
// nothing, and every `assertNoMailpitMessage`-shaped assertion would pass for
// the wrong reason. The notification worker is required too: a verification
// email only reaches the "email" queue AFTER the notification worker fans
// the notification job out to it. One Worker of each kind for the whole file
// (not one per test) — Worker construction opens a real connection and
// BullMQ blocking commands, which is not something to pay for per test.
const worker: Worker<EmailJobData> = startEmailWorker()
const notificationWorker = startNotificationWorker()

afterAll(async () => {
  // Same ordering as tests/integration/workers/email.worker.test.ts: workers
  // first (drains anything in flight), then obliterate so no job this file
  // enqueued lingers under this vitest worker's shared REDIS_KEY_PREFIX for the
  // next test file to trip over, then the shared connection.
  await worker.close()
  await notificationWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

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
 * The public projection of a user row (user.presenter.ts's `PublicUser`).
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
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
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
function findRefreshTokenCookie(response: Response): string | undefined {
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
): Promise<{ response: Response; body: ApiEnvelope<LoginBody> }> {
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
   *
   * Looked up by address rather than read out of the response body.
   * register's response does not carry the user any more (it would be an
   * enumeration oracle), and a helper that reads `body.data.id` does not
   * FAIL when that becomes null — it silently stops tracking the row and
   * leaks it into the shared worker database.
   * @param overrides - Fields to override on the default registration body.
   * @returns The raw supertest response, its typed envelope, and the email used.
   */
  async function registerUser(
    overrides: Partial<{
      email: string
      password: string
      firstName: string
      lastName: string
    }> = {}
  ): Promise<{ response: Response; body: ApiEnvelope<PublicUserBody>; email: string }> {
    const email = overrides.email ?? uniqueEmail()
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: VALID_PASSWORD, ...overrides })
    const body = envelopeOf<PublicUserBody>(response)
    const created = await userRepository.findByEmail(email)
    if (created) createdIds.push(created.id)
    return { response, body, email }
  }

  /**
   * Register a user and mark them verified, so a test that only needs a
   * usable account does not have to walk the verification flow. Marking is
   * done here, in the helper — NEVER by weakening login's guard.
   * @param overrides - Fields to override on the default registration body.
   * @returns The created user row and the address used.
   */
  async function registerVerifiedUser(
    overrides: Partial<{
      email: string
      password: string
      firstName: string
      lastName: string
    }> = {}
  ): Promise<{ user: User; email: string }> {
    const { email } = await registerUser(overrides)
    const user = await userRepository.findByEmail(email)
    if (!user) throw new Error(`registerVerifiedUser: no user for ${email}`)
    await sql`update users set email_verified_at = now() where id = ${user.id}`
    const verified = await userRepository.findById(user.id)
    if (!verified) throw new Error(`registerVerifiedUser: user vanished for ${email}`)
    return { user: verified, email }
  }

  describe('registration', () => {
    it('answers 202 with no user data — the response must not leak whether the address was free', async () => {
      const { response } = await registerUser()

      expect(response.status).toBe(202)
      expect(response.body).toEqual({
        success: true,
        message: 'If that address can be registered, a verification email has been sent.',
        statusCode: 202,
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
        data: null,
      })
    })

    it('accepts optional firstName and lastName and stores them', async () => {
      const { response, email } = await registerUser({ firstName: 'Ada', lastName: 'Lovelace' })

      expect(response.status).toBe(202)
      const stored = await userRepository.findByEmail(email)
      expect(stored?.firstName).toBe('Ada')
      expect(stored?.lastName).toBe('Lovelace')
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

      const { response, email } = await registerUser({ email: exact })

      expect(response.status).toBe(202)
      // 202 alone is what the taken branch also returns, so it proves nothing
      // about the insert — confirm the row was actually created.
      const stored = await userRepository.findByEmail(email)
      expect(stored).toBeDefined()

      // This is the boundary that first caught auth_providers.provider_id
      // being narrower (255) than users.email (MAX_EMAIL_LENGTH, 320): a
      // registration this long used to insert its `users` row and then
      // fail the SAME transaction's `auth_providers` insert with a raw
      // truncation error (500), for input `registerSchema` had already
      // accepted. Migration 0011 widened the column to match; this
      // assertion is what would go red again if that width regressed.
      const provider = await authProviderRepository.findByProviderAndId('email', email)
      expect(provider?.userId).toBe(stored?.id)
    })

    it('rejects a malformed email address with a field-level error', async () => {
      const { response, body } = await registerUser({ email: 'not-an-email' })

      expect(response.status).toBe(400)
      expect(body.errors?.email).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('answers a free address and a taken one identically', async () => {
      const taken = uniqueEmail()
      await registerUser({ email: taken })

      const free = await registerUser({ email: uniqueEmail() })
      const second = await registerUser({ email: taken })

      // Direct equality of status AND body. "Both are 2xx" would pass while
      // the bodies differed, which is the whole oracle.
      expect(free.response.status).toBe(second.response.status)
      expect(free.response.body).toEqual(second.response.body)
      expect(free.response.status).toBe(202)
      expect(free.response.body).toEqual({
        success: true,
        message: 'If that address can be registered, a verification email has been sent.',
        statusCode: 202,
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data", not undefined (which JSON.stringify omits entirely)
        data: null,
      })
    })

    it('mails a verification link to a free address', async () => {
      const email = uniqueEmail()
      await registerUser({ email })

      const messages = await findMailpitMessages(email)
      expect(messages).toHaveLength(1)
      expect(messages[0]?.Subject).toContain('Verify your email')
      const detail = await getMailpitMessage(messages[0]?.ID ?? '')
      expect(detail.Text).toContain('/verify-email?token=')
      await deleteMailpitMessage(messages[0]?.ID ?? '')

      // The actual proof that sendVerificationMail now routes through
      // addNotificationJob rather than addEmailJob directly: an in-app row
      // must also exist. No race to poll for — processNotificationJob
      // (notification.worker.ts) inserts this row BEFORE it enqueues the
      // paired email, so Mailpit already having the message above proves
      // this row was written first.
      const user = await userRepository.findByEmail(email)
      if (!user) throw new Error('mails a verification link: no stored row')
      const notifications = await sql`
        select * from notifications where user_id = ${user.id} and type = 'verify_email'
      `
      expect(notifications).toHaveLength(1)
    })

    it('mails a registration-attempt notice to a taken address', async () => {
      const email = uniqueEmail()
      await registerUser({ email })
      await drainMailpit(email)

      // Use toUpperCase: proves the taken branch fires case-insensitively,
      // covering the assertion the deleted "rejects a duplicate email that
      // only differs by case" test carried.
      await registerUser({ email: email.toUpperCase() })

      const messages = await findMailpitMessages(email)
      expect(messages).toHaveLength(1)
      // The notice must NOT carry a verification link: the person registering
      // is not necessarily the person who owns the mailbox, and a link here
      // would let the second registrant verify an account they do not own.
      const detail = await getMailpitMessage(messages[0]?.ID ?? '')
      expect(detail.Text).not.toContain('/verify-email?token=')
    })

    it('does not leak the stored user when the address is taken', async () => {
      const email = uniqueEmail()
      await registerUser({ email, firstName: 'Real' })

      const second = await registerUser({ email, firstName: 'Attacker' })

      expect(JSON.stringify(second.response.body)).not.toContain('Real')
      expect(envelopeOf<unknown>(second.response).data).toBeNull()
    })

    it('mails the STORED firstName on the taken branch, never the submitted one', async () => {
      // The response body carries no name either way (the test above), but
      // that leaves the outbound MAIL itself unpinned — `sendRegistrationAttemptMail`
      // (auth.service.ts) reads `existing?.firstName` off the row already
      // in the database, not `input.firstName` off this request's body. A
      // refactor that swapped one for the other would pass every test above
      // while delivering attacker-chosen text into the victim's inbox. This
      // reads the rendered mail body directly to pin that.
      const email = uniqueEmail()
      await registerUser({ email, firstName: 'Real' })
      await drainMailpit(email)

      await registerUser({ email, firstName: 'Attacker' })

      const messages = await findMailpitMessages(email)
      expect(messages).toHaveLength(1)
      const detail = await getMailpitMessage(messages[0]?.ID ?? '')
      // `Hi ${firstName},` (registration-attempt.template.ts) — the comma
      // makes this tight enough that a stray substring match elsewhere in
      // the mail (e.g. inside "Real" as a prefix of some other word)
      // couldn't produce a false pass.
      expect(detail.Text).toContain('Hi Real,')
      expect(detail.HTML).toContain('Real')
      expect(detail.Text).not.toContain('Attacker')
      expect(detail.HTML).not.toContain('Attacker')
      await deleteMailpitMessage(messages[0]?.ID ?? '')
    })

    it('answers identically for a soft-deleted address', async () => {
      // A soft-deleted address is free again (partial users_email_unique),
      // so this takes the fresh-account branch; either way the answer is
      // the same 202, which is what this test pins.
      const email = uniqueEmail()
      const { email: registered } = await registerUser({ email })
      const user = await userRepository.findByEmail(registered)
      await userRepository.softDelete(user?.id ?? '')

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: VALID_PASSWORD })
      const fresh = await userRepository.findByEmail(email)
      if (fresh) createdIds.push(fresh.id)

      expect(response.status).toBe(202)
      expect(envelopeOf<unknown>(response).data).toBeNull()
    })

    it('lets a soft-deleted address be registered again, as a new account', async () => {
      const email = uniqueEmail()
      await registerUser({ email })
      const original = await userRepository.findByEmail(email)
      if (!original) throw new Error('first registration created no row')
      await userRepository.softDelete(original.id)

      const { response } = await registerUser({ email })

      expect(response.status).toBe(202)
      const fresh = await userRepository.findByEmail(email)
      expect(fresh).toBeDefined()
      expect(fresh?.id).not.toBe(original.id)
    })

    it('normalises email case on registration, and the stored row agrees', async () => {
      const email = uniqueEmail()
      const mixedCase = `${email.slice(0, 1).toUpperCase()}${email.slice(1)}`.replace(
        '@example.test',
        '@EXAMPLE.test'
      )

      const { response, email: used } = await registerUser({ email: mixedCase })

      expect(response.status).toBe(202)
      const stored = await userRepository.findByEmail(used)
      if (!stored) throw new Error('normalises email: no stored row')
      expect(stored.email).toBe(mixedCase.toLowerCase())

      const [row] = await sql`select email from users where id = ${stored.id}`
      expect(row?.email).toBe(mixedCase.toLowerCase())
    })

    it('creates an email auth_providers row at registration, keyed on the lowercased address', async () => {
      // See auth.service.ts's `register`: the row must use the LOWERCASED
      // address as `providerId`, matching `findOrCreateByGoogle`'s own `'email'` row
      // for a brand-new Google user — `auth_providers_provider_provider_id_unique`
      // (auth-provider.model.ts) has no case-folding of its own, so a
      // raw-cased row here could let the same address collide
      // inconsistently between the two creation paths.
      const email = uniqueEmail()
      const mixedCase = `${email.slice(0, 1).toUpperCase()}${email.slice(1)}`.replace(
        '@example.test',
        '@EXAMPLE.test'
      )

      const { response, email: used } = await registerUser({ email: mixedCase })

      expect(response.status).toBe(202)
      const stored = await userRepository.findByEmail(used)
      if (!stored) throw new Error('email provider row: no stored user')

      const provider = await authProviderRepository.findByProviderAndId(
        'email',
        mixedCase.toLowerCase()
      )
      expect(provider?.userId).toBe(stored.id)

      // Exactly one provider row — registration must not also create a
      // 'google' row, and must not create the 'email' row twice.
      const providers = await authProviderRepository.findByUser(stored.id)
      expect(providers.map((row) => row.provider)).toEqual(['email'])
    })

    // Mutation proof: if the check that classifies the taken branch (a 409
    // from UserRepository.create inside auth.service's register transaction)
    // stopped recognising a duplicate, the taken branch would answer
    // differently from the free one and the oracle test above must go RED.
    // Disguises that 409 as a 422 on UserRepository.prototype; withMutatedMethod
    // per CLAUDE.md, no source files touched.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'MUTATION PROOF: an unrecognised unique violation on the taken branch is detected as an oracle',
      async () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
        const originalCreate = UserRepository.prototype.create
        const mutatedCreate: typeof originalCreate = async function (
          this: UserRepository,
          ...arguments_
        ) {
          try {
            return await originalCreate.apply(this, arguments_)
          } catch (error) {
            if (error instanceof HttpError && error.statusCode === 409) {
              throw new HttpError(error.message, 422)
            }
            throw error
          }
        }

        await withMutatedMethod(UserRepository.prototype, 'create', mutatedCreate, async () => {
          const taken = uniqueEmail()
          // First register succeeds (no duplicate yet).
          const firstResponse = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: taken, password: VALID_PASSWORD })
          const firstUser = await userRepository.findByEmail(taken)
          if (firstUser) createdIds.push(firstUser.id)
          expect(firstResponse.status).toBe(202)

          // Second register hits the mutated 422, proving the oracle.
          const secondResponse = await request(app)
            .post('/api/v1/auth/register')
            .send({ email: taken, password: VALID_PASSWORD })
          expect(secondResponse.status).not.toBe(202)
        })
      }
    )
  })

  describe('login', () => {
    it('logs in with correct credentials, returns an access token, and sets a refresh cookie', async () => {
      // registerVerifiedUser, not registerUser: a freshly registered
      // account is unverified by design (Task 9's guard below refuses it),
      // so "correct credentials succeed" is only true once the account has
      // been verified — the same precondition every other successful-login
      // test in this file already satisfies.
      const { email } = await registerVerifiedUser()

      const { response, body } = await login(email, VALID_PASSWORD)

      expect(response.status).toBe(200)
      expect(body.data).toEqual({
        user: {
          id: ANY_STRING,
          email,
          firstName: NO_NAME,
          lastName: NO_NAME,
          createdAt: ANY_STRING,
          platformRole: NO_NAME,
        },
        accessToken: ANY_STRING,
      })
      // /password/i, not /passwordhash/i: the stricter pattern, used
      // identically in the registration test above. A leaked `password`
      // key — or any other field whose name merely contains it — slips past
      // a check that only looks for the exact column name.
      expect(JSON.stringify(response.body)).not.toMatch(/password/i)

      const refreshCookie = findRefreshTokenCookie(response)
      expect(refreshCookie).toBeDefined()
      expect(refreshCookie).toMatch(/HttpOnly/i)
      expect(refreshCookie).toMatch(/SameSite=Strict/i)
      expect(refreshCookie).toContain(`Path=${REFRESH_TOKEN_COOKIE_PATH}`)
      // Neither Secure nor Domain under APP_ENV=local with no COOKIE_*
      // overrides; cookie-attributes.test.ts covers the other settings.
      expect(refreshCookie).not.toMatch(/Secure/i)
      expect(refreshCookie).not.toMatch(/Domain=/i)
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
      await registerUser({ email })
      const user = await userRepository.findByEmail(email)
      if (!user) throw new Error('setup: registration did not create a row')
      await userRepository.softDelete(user.id)

      const { response } = await login(email, VALID_PASSWORD)

      expect(response.status).toBe(401)
      expect(findRefreshTokenCookie(response)).toBeUndefined()
    })

    it('refuses login for a deactivated (active: false) user, through the same rejection', async () => {
      const email = uniqueEmail()
      await registerUser({ email })
      const user = await userRepository.findByEmail(email)
      if (!user) throw new Error('setup: registration did not create a row')
      await userRepository.update(user.id, { active: false })

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

    it('refuses a cross-site form POST outright, so it can never set a session cookie', async () => {
      // The CSRF direction SECURITY.md's own section did not consider: not
      // an attacker using the victim's credentials, but an attacker's page
      // auto-submitting a form that logs the VICTIM into the ATTACKER's
      // account. `sameSite: 'strict'` does not help — it governs when a
      // cookie is SENT, not whether a cross-site response may SET one.
      //
      // Real, registered credentials are used here deliberately: the point
      // is that the request is refused on its ENCODING, before the
      // controller ever looks at the body, so credentials that would
      // otherwise succeed still set no cookie.
      const email = uniqueEmail()
      await registerUser({ email })

      const response = await request(app)
        .post('/api/v1/auth/login')
        .type('form')
        .send({ email, password: VALID_PASSWORD })

      expect(response.status).toBe(415)
      expect(findRefreshTokenCookie(response)).toBeUndefined()
    })

    it('rejects a login request missing the password field with a validation error', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({ email: uniqueEmail() })
      const body = envelopeOf<LoginBody>(response)

      expect(response.status).toBe(400)
      expect(body.errors?.password).toEqual(expect.arrayContaining([expect.any(String)]))
    })

    it('records lastLoggedInAt on a successful login', async () => {
      const { user, email } = await registerVerifiedUser()
      expect(user.lastLoggedInAt).toBeNull()

      await request(app).post('/api/v1/auth/login').send({ email, password: VALID_PASSWORD })

      const reread = await userRepository.findById(user.id)
      expect(reread?.lastLoggedInAt).toBeInstanceOf(Date)
      // updated_at must move with it — the row is not allowed to claim it
      // was last touched before the login that just wrote to it.
      expect(reread?.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
    })

    it('does not record lastLoggedInAt when the password is wrong', async () => {
      const { user, email } = await registerVerifiedUser()

      await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-password-entirely' })

      const reread = await userRepository.findById(user.id)
      expect(reread?.lastLoggedInAt).toBeNull()
    })

    it('refuses an unverified account, identically to a wrong password', async () => {
      const { email } = await registerUser()
      const { email: otherEmail } = await registerVerifiedUser()
      // Fixed across both requests, exactly like the unknown-email/wrong-
      // password oracle test above: the envelope carries a per-request
      // `requestId`, so without pinning it the two bodies would never
      // deep-equal regardless of the guard's behavior.
      const fixedRequestId = randomUUID()

      const unverified = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Request-Id', fixedRequestId)
        .send({ email, password: VALID_PASSWORD })
      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Request-Id', fixedRequestId)
        .send({ email: otherEmail, password: 'wrong-password-entirely' })

      // Asserted together, not each in isolation: this is the only way to
      // pin that an unverified account is indistinguishable from a wrong
      // password, not merely "also a 401".
      expect(unverified.status).toBe(wrongPassword.status)
      expect(unverified.body).toEqual(wrongPassword.body)
      expect(unverified.status).toBe(401)
    })

    it('lets the same account in once it is verified', async () => {
      const { email } = await registerUser()
      const beforeVerification = await login(email, VALID_PASSWORD)
      expect(beforeVerification.response.status).toBe(401)

      const user = await userRepository.findByEmail(email)
      if (!user) throw new Error('setup: registration did not create a row')
      await sql`update users set email_verified_at = now() where id = ${user.id}`

      const afterVerification = await login(email, VALID_PASSWORD)
      expect(afterVerification.response.status).toBe(200)
    })

    // Mutation proof for the `!user.emailVerifiedAt` clause, same two-part
    // shape as tests/integration/services/token-reuse-mutation.test.ts:
    //
    //   1. Always on: mutate UserRepository.prototype.findByEmail to report
    //      every row as verified regardless of its real emailVerifiedAt
    //      value, show a genuinely unverified account logs in anyway, then
    //      restore and show the SAME account is refused again. Exercises
    //      the harness against this real guard; always green.
    //   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, one per test
    //      above, each reproducing that test's own assertions against the
    //      mutated dependency — DELIBERATELY red under the flag, skipped
    //      (green) otherwise. No file under src/ is ever opened for
    //      writing; see CLAUDE.md.
    //
    //     MUTATION_PROOF=1 pnpm exec vitest run tests/integration/api/auth.test.ts   # red
    //     pnpm exec vitest run tests/integration/api/auth.test.ts                    # green
    //
    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const originalFindByEmail = UserRepository.prototype.findByEmail
    const mutatedFindByEmail: typeof originalFindByEmail = async function (
      this: UserRepository,
      email,
      options
    ) {
      const user = await originalFindByEmail.call(this, email, options)
      return user ? { ...user, emailVerifiedAt: new Date() } : user
    }

    it('disabling the emailVerifiedAt check lets an unverified account log in; restoring it brings the gate back', async () => {
      const { email } = await registerUser()

      await withMutatedMethod(
        UserRepository.prototype,
        'findByEmail',
        mutatedFindByEmail,
        async () => {
          const mutated = await login(email, VALID_PASSWORD)
          // The bug this proves: a genuinely unverified account (real
          // emailVerifiedAt is still null) logs in anyway.
          expect(mutated.response.status).toBe(200)
        }
      )

      // RESTORED: the same account, still genuinely unverified, is refused
      // again — same call, harness back to its real implementation.
      const restored = await login(email, VALID_PASSWORD)
      expect(restored.response.status).toBe(401)
    })

    // DELIBERATELY red when run with MUTATION_PROOF=1 — see this block's
    // header comment. Left unset, this test is skipped and the file is
    // green.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'reproduces the real "refuses an unverified account" test’s own assertions against the mutated guard',
      async () => {
        await withMutatedMethod(
          UserRepository.prototype,
          'findByEmail',
          mutatedFindByEmail,
          async () => {
            const { email } = await registerUser()
            const { email: otherEmail } = await registerVerifiedUser()
            const fixedRequestId = randomUUID()

            const unverified = await request(app)
              .post('/api/v1/auth/login')
              .set('X-Request-Id', fixedRequestId)
              .send({ email, password: VALID_PASSWORD })
            const wrongPassword = await request(app)
              .post('/api/v1/auth/login')
              .set('X-Request-Id', fixedRequestId)
              .send({ email: otherEmail, password: 'wrong-password-entirely' })

            // With findByEmail mutated, the unverified account's row looks
            // verified to the controller, so this login SUCCEEDS (200)
            // while the wrong-password branch still fails (401) on its own
            // merits — the two diverge, and this assertion goes RED.
            expect(unverified.status).toBe(wrongPassword.status)
            expect(unverified.body).toEqual(wrongPassword.body)
            expect(unverified.status).toBe(401)
          }
        )
      }
    )

    // DELIBERATELY red when run with MUTATION_PROOF=1 — see this block's
    // header comment. Left unset, this test is skipped and the file is
    // green.
    it.runIf(process.env.MUTATION_PROOF === '1')(
      'reproduces the real "lets the same account in once it is verified" test’s own assertions against the mutated guard',
      async () => {
        await withMutatedMethod(
          UserRepository.prototype,
          'findByEmail',
          mutatedFindByEmail,
          async () => {
            const { email } = await registerUser()

            // With findByEmail mutated, the account logs in while still
            // genuinely unverified — the real test's "before verification"
            // assertion (401) goes RED here, immediately.
            const beforeVerification = await login(email, VALID_PASSWORD)
            expect(beforeVerification.response.status).toBe(401)
          }
        )
      }
    )
  })

  describe('logout', () => {
    it('stops honouring the access token as soon as the user logs out', async () => {
      // registerVerifiedUser + login, not signAccessToken(user, randomUUID()):
      // a fabricated session id has no user_tokens row behind it, so the
      // denylist (which denies by PRESENCE) would never deny it and this
      // test would pass vacuously once Task 4 lands. The access token must
      // carry the `sid` this login actually created.
      const { email } = await registerVerifiedUser()
      const { response: loginResponse, body: loginBody } = await login(email, VALID_PASSWORD)
      const accessToken = loginBody.data?.accessToken
      expect(accessToken).toBeDefined()

      const refreshCookie = findRefreshTokenCookie(loginResponse)
      expect(refreshCookie).toBeDefined()

      // Works before logout — the token is genuinely valid for a live
      // session.
      const beforeLogout = await request(app)
        .get('/api/v1/profile')
        .set('Authorization', `Bearer ${accessToken as string}`)
      expect(beforeLogout.status).toBe(200)

      // The refresh cookie (not the bearer token) is what tells logout
      // which session to revoke — see auth.controller.ts's `logout`.
      const logoutResponse = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', refreshCookie as string)
      expect(logoutResponse.status).toBe(200)

      // THE WHOLE POINT: the same access token, which has NOT expired, is
      // now refused. As of this task, this assertion STILL FAILS —
      // `revokeAllForSession` writes the denylist entry, but nothing reads
      // it yet. Task 4 adds the read side (requireAuth checking
      // isSessionDenied); see task-3-brief.md.
      const afterLogout = await request(app)
        .get('/api/v1/profile')
        .set('Authorization', `Bearer ${accessToken as string}`)
      expect(afterLogout.status).toBe(401)
    })
  })
})
