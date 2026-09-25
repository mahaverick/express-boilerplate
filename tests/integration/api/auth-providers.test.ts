// tests/integration/api/auth-providers.test.ts
//
// Integration tests for GET /api/v1/auth/providers, against the real
// per-worker Postgres database — same conventions as
// tests/integration/api/profile.test.ts, whose token approach this file
// reuses: requests sign a bearer token directly with `signAccessToken`
// rather than going through POST /auth/login, since these tests are about
// what happens AFTER authentication rather than about login itself.
//
// The case this file exists for is the Google-only user. A Google signup
// writes BOTH an `'email'` row and a `'google'` row in one transaction
// (auth.controller.ts's `createGoogleUser`), so the presence of an
// `'email'` provider says nothing about whether a password exists — a
// naive implementation that inferred `hasPassword` from the provider list
// would report `true` for an account that cannot log in with a password at
// all. That is why the endpoint carries `hasPassword` as its own field,
// read from `users.password_hash`, and why the assertions below pin the
// two apart.
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { AuthProvider } from '@/constants/auth-provider.constants'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { hashPassword } from '@/utilities/password.utilities'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

const PASSWORD = 'correct horse battery staple'

// vitest types `expect.any(...)` as `any` — see
// tests/integration/api/profile.test.ts's own comment for why this cast
// exists and is reused as one shared instance across every assertion.
const ANY_STRING = expect.any(String) as unknown as string

const createdIds: string[] = []

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
 * The body this endpoint returns.
 */
interface ProvidersBody {
  providers: { provider: AuthProvider; linkedAt: string }[]
  hasPassword: boolean
}

/**
 * Cast a supertest response's body to a known envelope shape. supertest
 * types `.body` as `any`; every access after this point is type-checked.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-providers-${randomUUID()}@example.com`
}

/**
 * Create a user and link the given providers to it, tracking the row for
 * cleanup.
 * @param options - How to build the account.
 * @param options.withPassword - Whether `password_hash` is set; false models a federated-only account.
 * @param options.providers - The providers to link, in the order given.
 * @returns The created user's id and a bearer token for it.
 */
async function seedUser(options: {
  withPassword: boolean
  providers: AuthProvider[]
}): Promise<{ userId: string; token: string }> {
  const email = uniqueEmail()
  const passwordHash = options.withPassword ? await hashPassword(PASSWORD) : undefined
  const created = await userRepository.create({
    email,
    ...(passwordHash && { passwordHash }),
  })
  createdIds.push(created.id)

  for (const provider of options.providers) {
    await authProviderRepository.create({
      userId: created.id,
      provider,
      // The real shapes: the `'email'` row's providerId IS the address,
      // Google's is its stable `sub`. Both are what the production paths
      // write (auth.controller.ts), so a test asserting the response never
      // leaks `providerId` is asserting against realistic values rather
      // than a placeholder that could not leak anything anyway.
      providerId: provider === 'email' ? email : `google-sub-${randomUUID()}`,
    })
  }

  const user = await userRepository.findById(created.id)
  if (!user) throw new Error(`seedUser: user vanished for ${email}`)
  return { userId: created.id, token: signAccessToken(user, randomUUID()) }
}

/**
 * GET /api/v1/auth/providers as the given bearer token.
 * @param token - The access token, or undefined to send no Authorization header.
 * @returns The supertest response.
 */
async function getProviders(token?: string): Promise<Response> {
  const pending = request(app).get('/api/v1/auth/providers')
  return token ? pending.set('Authorization', `Bearer ${token}`) : pending
}

/**
 * The providers a response lists, in the order it listed them.
 * @param response - The supertest response.
 * @returns The provider names, or an empty array when the body carried none.
 */
function providerOrder(response: Response): string[] {
  return envelopeOf<ProvidersBody>(response).data?.providers.map((entry) => entry.provider) ?? []
}

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from users where id = any(${createdIds})`
  createdIds.length = 0
})

describe('GET /api/v1/auth/providers', () => {
  it('reports one email provider and a password for an email registration', async () => {
    const { token } = await seedUser({ withPassword: true, providers: ['email'] })

    const response = await getProviders(token)

    expect(response.status).toBe(200)
    expect(envelopeOf<ProvidersBody>(response).data).toEqual({
      providers: [{ provider: 'email', linkedAt: ANY_STRING }],
      hasPassword: true,
    })
  })

  it('reports hasPassword false for a Google-only account, which still has an email provider row', async () => {
    // THE case this endpoint's `hasPassword` field exists for. A Google
    // signup writes both rows, so `providers` here is indistinguishable
    // from a linked account's — only `hasPassword` tells them apart, and an
    // implementation that derived it from the provider list would answer
    // `true` and send this user to a change-password form they cannot use.
    const { token } = await seedUser({ withPassword: false, providers: ['email', 'google'] })

    const response = await getProviders(token)

    expect(response.status).toBe(200)
    const body = envelopeOf<ProvidersBody>(response).data
    expect(body?.hasPassword).toBe(false)
    expect(body?.providers.map((entry) => entry.provider)).toEqual(['email', 'google'])
  })

  it('reports both providers and a password for an account that linked Google to an email login', async () => {
    const { token } = await seedUser({ withPassword: true, providers: ['email', 'google'] })

    const response = await getProviders(token)

    expect(response.status).toBe(200)
    const body = envelopeOf<ProvidersBody>(response).data
    expect(body?.hasPassword).toBe(true)
    expect(body?.providers).toHaveLength(2)
  })

  it('never exposes providerId, for either provider', async () => {
    // `providerId` is the caller's own email for `'email'` and Google's
    // stable `sub` for `'google'`. Neither belongs in this response, and
    // the `sub` especially has no reason to leave the server. Asserted
    // against the raw body text rather than the parsed shape, so a nested
    // or renamed leak is caught too.
    const { userId } = await seedUser({ withPassword: true, providers: ['email', 'google'] })
    const rows = await authProviderRepository.findByUser(userId)
    const user = await userRepository.findById(userId)
    if (!user) throw new Error('providerId test: user vanished')

    const response = await getProviders(signAccessToken(user, randomUUID()))

    expect(response.status).toBe(200)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(JSON.stringify(response.body)).not.toContain(row.providerId)
    }
  })

  it('orders providers oldest first, even when that is not the order they were inserted in', async () => {
    // Postgres guarantees no order without an ORDER BY, and in practice
    // returns rows roughly in insertion order — so seeding `email` then
    // `google` and asserting that order back would pass with the sort
    // REMOVED, proving nothing. Backdating the `google` row makes
    // insertion order and `createdAt` order disagree, so only a controller
    // that actually sorts can answer `['google', 'email']`.
    const { userId, token } = await seedUser({
      withPassword: true,
      providers: ['email', 'google'],
    })
    await sql`
      update auth_providers set created_at = now() - interval '1 day'
      where user_id = ${userId} and provider = 'google'
    `

    const first = await getProviders(token)
    const second = await getProviders(token)

    expect(first.status).toBe(200)
    expect(providerOrder(first)).toEqual(['google', 'email'])
    // And stable: two identical requests agree, which is the property a UI
    // rendering this list depends on.
    expect(providerOrder(second)).toEqual(providerOrder(first))
  })

  it('rejects an unauthenticated request with 401', async () => {
    const response = await getProviders()

    expect(response.status).toBe(401)
    expect(envelopeOf<ProvidersBody>(response).success).toBe(false)
  })
})
