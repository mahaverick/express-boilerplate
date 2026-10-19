/**
 * @file GET /api/v1/auth/providers against the real per-worker Postgres
 * database. Requests sign a bearer token directly with `signAccessToken`
 * instead of signing in, as profile.test.ts does. Every account has its
 * 'email' row, since an emailed link signs any account in; a Google sign-up
 * adds a 'google' row beside it.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { AuthProvider } from '@/constants/auth-provider.constants'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

/**
 * vitest types `expect.any(...)` as `any`; cast once and reused across the
 * assertions.
 */
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
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `auth-providers-${randomUUID()}@example.com`
}

/**
 * Create a user and link the given providers to it, tracking the row for
 * cleanup.
 * @param options - How to build the account.
 * @param options.providers - The providers to link, in the order given.
 * @returns The created user's id and a bearer token for it.
 */
async function seedUser(options: {
  providers: AuthProvider[]
}): Promise<{ userId: string; token: string }> {
  const email = uniqueEmail()
  const created = await userRepository.create({ email })
  createdIds.push(created.id)

  for (const provider of options.providers) {
    await authProviderRepository.create({
      userId: created.id,
      provider,
      // The real shapes production writes: the 'email' row's providerId is the address, Google's is its stable sub.
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
  it('answers providers only, with the email row for every account', async () => {
    const { token } = await seedUser({ providers: ['email'] })

    const response = await getProviders(token)

    expect(response.status).toBe(200)
    const data = envelopeOf<ProvidersBody>(response).data
    expect(Object.keys(data ?? {})).toEqual(['providers'])
    expect(data?.providers).toEqual([{ provider: 'email', linkedAt: ANY_STRING }])
  })

  it('reports both providers for an account that signed up with Google, which has an email row too', async () => {
    const { token } = await seedUser({ providers: ['email', 'google'] })

    const response = await getProviders(token)

    expect(response.status).toBe(200)
    const body = envelopeOf<ProvidersBody>(response).data
    expect(body?.providers.map((entry) => entry.provider)).toEqual(['email', 'google'])
  })

  it('never exposes providerId, for either provider', async () => {
    // Asserted against the raw body text rather than the parsed shape, so a nested or renamed leak is caught too.
    const { userId } = await seedUser({ providers: ['email', 'google'] })
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
    // Backdating the google row makes insertion order and createdAt order disagree, so only an endpoint that sorts can answer ['google', 'email'].
    const { userId, token } = await seedUser({ providers: ['email', 'google'] })
    await sql`
      update auth_providers set created_at = now() - interval '1 day'
      where user_id = ${userId} and provider = 'google'
    `

    const first = await getProviders(token)
    const second = await getProviders(token)

    expect(first.status).toBe(200)
    expect(providerOrder(first)).toEqual(['google', 'email'])
    // And stable: two identical requests agree, the property a UI rendering this list depends on.
    expect(providerOrder(second)).toEqual(providerOrder(first))
  })

  it('rejects an unauthenticated request with 401', async () => {
    const response = await getProviders()

    expect(response.status).toBe(401)
    expect(envelopeOf<ProvidersBody>(response).success).toBe(false)
  })
})
