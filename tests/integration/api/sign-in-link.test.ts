/**
 * @file `POST /api/v1/auth/link/request` and `POST /api/v1/auth/link/verify`:
 * one fixed 202 for every address, sent before any lookup; one link per
 * address per cooldown and per daily budget; the redirect stored and handed
 * back; the first click creating a verified account; one generic
 * `LINK_INVALID` for every dead link; one session per link however many
 * presentations race; and the maintenance modes deciding on a read-only
 * peek, so a refused link stays usable. Delivery is read from Mailpit only
 * where a test asserts the mail's link; elsewhere the `email_messages` rows
 * are counted. The follow-up's absence of mail is asserted by awaiting the
 * follow-up itself (`requestSignInLink`), never by waiting on the clock.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { LINK_INVALID_CODE } from '@/constants/auth.constants'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { EmailJobData } from '@/jobs/email.job'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { addressDigest } from '@/services/mail-cooldown.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken, issueRefreshToken } from '@/services/session.service'
import { spendSignInLinkBudget } from '@/services/sign-in-link-limit.service'
import { requestSignInLink, sendSignInLink } from '@/services/sign-in-link.service'
import type { DomainEvent } from '@/types/domain-event'
import { startEmailWorker } from '@/workers/email.worker'
import { deferred } from '../../helpers/lock-probe'
import { findMailpitMessages, getMailpitMessage } from '../../helpers/mailpit'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'
import { issueTestLink, signInByLink } from '../../helpers/sign-in'
import { settle, waitUntil } from '../../helpers/timing'

vi.mock('@/services/sign-in-link-limit.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sign-in-link-limit.service')>()
  return { ...actual, spendSignInLinkBudget: vi.fn(actual.spendSignInLinkBudget) }
})

const app = createApp()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()
const { name: REFRESH_COOKIE_NAME } = testRefreshCookie()

/**
 * The mail is asserted on in Mailpit by two tests, so the file runs its own
 * email Worker; `createApp()` starts none.
 */
const worker: Worker<EmailJobData> = startEmailWorker()

afterAll(async () => {
  await worker.close()
  await getEmailQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * The fixed 202 body `POST /auth/link/request` answers every address with.
 */
const REQUEST_ACCEPTED_BODY = {
  success: true,
  message: 'Check your inbox for a sign-in link.',
  statusCode: 202,
  // eslint-disable-next-line unicorn/no-null -- the envelope's JSON null for "no data"
  data: null,
}

/**
 * Every address this file used, lowercased, for `afterEach` to delete the
 * rows written for it: links, messages and the accounts a click created.
 */
const usedEmails: string[] = []

/**
 * Every domain event emitted while this file runs, in order.
 */
const emitted: DomainEvent[] = []
for (const type of ['user_signed_up', 'user_signed_in', 'email_verified'] as const) {
  subscribeDomainEvent(type, (event) => {
    emitted.push(event)
  })
}

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test, for reading rows while debugging.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `link-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * The live and dead sign-in link rows of one address, oldest first.
 * @param email - The address.
 * @returns The rows' columns these tests read.
 */
async function linkRows(
  email: string
): Promise<{ userId: string | null; app: string; redirect: string | null; revoked: boolean }[]> {
  return sql<{ userId: string | null; app: string; redirect: string | null; revoked: boolean }[]>`
    select user_id as "userId", app, redirect, revoked_at is not null as revoked
    from user_tokens
    where email = ${email.toLowerCase()} and purpose = 'sign_in_link'
    order by created_at, id
  `
}

/**
 * How many `sign_in_link` messages one address was sent.
 * @param email - The address.
 * @returns The count of `email_messages` rows.
 */
async function messageCount(email: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from email_messages
    where recipient = ${email.toLowerCase()} and template_key = 'sign_in_link'
  `
  return row?.count ?? 0
}

/**
 * A user's refresh rows: whether each is revoked.
 * @param userId - The user.
 * @returns One flag per row, oldest first.
 */
async function refreshRows(userId: string): Promise<{ revoked: boolean }[]> {
  return sql<{ revoked: boolean }[]>`
    select revoked_at is not null as revoked from user_tokens
    where user_id = ${userId} and purpose = 'refresh'
    order by created_at, id
  `
}

/**
 * The events emitted for one user, by type.
 * @param userId - The user.
 * @returns The events, in emit order.
 */
function eventsFor(userId: string): DomainEvent[] {
  return emitted.filter((event) => 'userId' in event && event.userId === userId)
}

/**
 * Post a link request.
 * @param body - The JSON body.
 * @returns The response.
 */
function postRequest(body: Record<string, unknown>): Promise<Response> {
  return request(app).post('/api/v1/auth/link/request').send(body)
}

/**
 * Post a link verify.
 * @param token - The raw token.
 * @param cookie - A `Cookie` header to present, if any.
 * @returns The response.
 */
function postVerify(token: string, cookie?: string): Promise<Response> {
  const pending = request(app).post('/api/v1/auth/link/verify')
  if (cookie !== undefined) pending.set('Cookie', cookie)
  return pending.send({ token })
}

/**
 * An error body without its per-request id, for comparing two refusals.
 * @param response - The response.
 * @returns The body minus `requestId`.
 */
function refusalBody(response: Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(([key]) => key !== 'requestId')
  )
}

/**
 * The `data` of a verify that answered 200.
 */
interface VerifyData {
  user: { id: string; email: string; platformRole: string | null }
  accessToken: string
  isNewUser: boolean
  redirect: string | null
}

/**
 * Read a 200 verify's data.
 * @param response - The response.
 * @returns Its `data`.
 */
function verifyData(response: Response): VerifyData {
  return (response.body as { data: VerifyData }).data
}

/**
 * The sign-in link in the newest mail to an address, from Mailpit.
 * @param email - The recipient.
 * @returns The link, parsed.
 */
async function mailedLink(email: string): Promise<URL> {
  const [message] = await findMailpitMessages(email)
  if (!message) throw new Error(`no mail reached ${email}`)
  const detail = await getMailpitMessage(message.ID)
  const href = /https?:\/\/\S+\/auth\/link\?\S+/.exec(detail.Text)?.[0]
  if (href === undefined) throw new Error('the mail carries no sign-in link')
  return new URL(href)
}

/**
 * Delete every key of one limiter, so the IP-keyed budgets this file
 * spends do not carry from one test to the next.
 * @param name - The limiter's name.
 */
async function clearLimiter(name: string): Promise<void> {
  const client = await getRedis()
  const keys: string[] = []
  const batches = client.scanIterator({ MATCH: `${redisKey('rl', name)}:*` })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await client.del(keys)
}

beforeEach(async () => {
  await clearLimiter('sign-in-link-request')
  await clearLimiter('sign-in-link-verify')
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  vi.mocked(spendSignInLinkBudget).mockClear()
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

describe('POST /auth/link/request', () => {
  it('answers one 202 body for a new, an existing, a deactivated and a malformed-case address', async () => {
    const fresh = uniqueEmail('new')
    const existing = await createTrackedUser({ email: uniqueEmail('existing') })
    const deactivated = await createTrackedUser({
      email: uniqueEmail('deactivated'),
      active: false,
    })
    const mixedCase = uniqueEmail('mixed')

    const responses = await Promise.all([
      postRequest({ email: fresh }),
      postRequest({ email: existing.email }),
      postRequest({ email: deactivated.email }),
      postRequest({ email: `  ${mixedCase.toUpperCase()} ` }),
    ])

    for (const response of responses) {
      expect(response.status).toBe(202)
      expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
      expect(response.text).toBe(responses[0]?.text)
    }
    // The follow-ups run after the reply; wait for the three that mail before cleanup.
    for (const email of [fresh, existing.email, mixedCase]) {
      await waitUntil(async () => (await messageCount(email)) === 1 || undefined, {
        message: `the link mailed to ${email}`,
      })
    }
    await settle(300, 'the deactivated address gets nothing; absence has no event')
    expect(await messageCount(deactivated.email)).toBe(0)
  })

  it('replies before the lookup', async () => {
    const email = uniqueEmail('before-lookup')
    const reached = deferred()
    const release = deferred()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realFind = UserRepository.prototype.findByEmail
    /**
     * Stands in for `findByEmail`: it signals, then holds the lookup until released.
     */
    const blockingFind: typeof realFind = async function (this: UserRepository, ...arguments_) {
      reached.resolve()
      await release.promise
      return realFind.apply(this, arguments_)
    }

    await withMutatedMethod(UserRepository.prototype, 'findByEmail', blockingFind, async () => {
      try {
        const response = await postRequest({ email })
        expect(response.status).toBe(202)
        // The reply is in hand while the follow-up's lookup has not returned.
        await reached.promise
      } finally {
        release.resolve()
      }
    })
    await waitUntil(async () => (await messageCount(email)) === 1 || undefined, {
      message: 'the link the released lookup goes on to mail',
    })
  })

  it('mails a link to an unknown address on web, keyed by email with no user', async () => {
    const email = uniqueEmail('unknown')

    const response = await postRequest({ email, app: 'web' })
    expect(response.status).toBe(202)

    const [row] = await waitUntil(
      async () => {
        const rows = await linkRows(email)
        return rows.length > 0 ? rows : undefined
      },
      { message: 'the issued link row' }
    )
    // eslint-disable-next-line unicorn/no-null -- a sign_in_link row names no user
    expect(row).toMatchObject({ userId: null, app: 'web', revoked: false })
    const link = await mailedLink(email)
    expect(link.pathname).toBe('/auth/link')
    expect(link.searchParams.get('token')).toMatch(/^[\w-]{43}$/)
    expect(link.searchParams.get('email')).toBe(email)
    expect(link.searchParams.has('redirect')).toBe(false)
  })

  it('mails nothing to a deactivated user', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('inactive'), active: false })

    await requestSignInLink({ email: user.email, app: 'web' })()

    expect(await linkRows(user.email)).toEqual([])
    expect(await messageCount(user.email)).toBe(0)
  })

  it('mails one link per SIGN_IN_LINK_MAIL_COOLDOWN per address', async () => {
    const email = uniqueEmail('cooldown')

    await requestSignInLink({ email, app: 'web' })()
    await requestSignInLink({ email, app: 'web' })()

    expect(await linkRows(email)).toHaveLength(1)
    expect(await messageCount(email)).toBe(1)
  })

  it('stops at SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT', async () => {
    const email = uniqueEmail('budget')
    vi.mocked(spendSignInLinkBudget).mockResolvedValueOnce('exhausted')

    await requestSignInLink({ email, app: 'web' })()

    expect(spendSignInLinkBudget).toHaveBeenCalledWith(email)
    expect(await linkRows(email)).toEqual([])
    expect(await messageCount(email)).toBe(0)
  })

  it('revokes the earlier unused link when a new one is sent', async () => {
    const email = uniqueEmail('supersede')

    await requestSignInLink({ email, app: 'web' })()
    const redis = await getRedis()
    await redis.del(redisKey('sign-in-link', addressDigest(email)))
    await requestSignInLink({ email, app: 'web' })()

    const rows = await linkRows(email)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.revoked)).toEqual([true, false])
  })

  it('stores the redirect and puts it on the link', async () => {
    const email = uniqueEmail('redirect')
    const redirect = '/tenants/acme/members?tenant=acme&tab=2#x'

    const response = await postRequest({ email, redirect })
    expect(response.status).toBe(202)

    const [row] = await waitUntil(
      async () => {
        const rows = await linkRows(email)
        return rows.length > 0 ? rows : undefined
      },
      { message: 'the issued link row' }
    )
    expect(row?.redirect).toBe(redirect)
    const link = await mailedLink(email)
    expect(link.searchParams.get('redirect')).toBe(redirect)
  })

  it.each(['staff', 'welcome'] as const)(
    'mails a %s link with the team-admin sentence, greeting the account by its stored name',
    async (reason) => {
      const user = await createTrackedUser({ email: uniqueEmail(reason), firstName: 'Grace' })

      await sendSignInLink({ email: user.email, app: 'web', userId: user.id, reason })

      const [message] = await sql<{ userId: string | null; variables: Record<string, unknown> }[]>`
        select user_id as "userId", variables from email_messages
        where recipient = ${user.email} and template_key = 'sign_in_link'
      `
      expect(message?.userId).toBe(user.id)
      expect(message?.variables).toEqual({
        firstName: 'Grace',
        expiresInMinutes: '15',
        appName: expect.any(String) as unknown,
        reason: 'staff',
      })
    }
  )

  it('refuses a bad redirect with 400 errors.redirect', async () => {
    const email = uniqueEmail('bad-redirect')

    const response = await postRequest({ email, redirect: '//evil.test' })

    expect(response.status).toBe(400)
    expect((response.body as { errors?: Record<string, unknown> }).errors).toHaveProperty(
      'redirect'
    )
  })

  describe('redirect validation', () => {
    it.each([
      ['a protocol-relative URL', '//evil.test'],
      ['a backslash after the slash', String.raw`/\evil.test`],
      ['an absolute URL', 'https://evil.test'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a newline', '/a\nb'],
      ['2049 characters', `/${'a'.repeat(2048)}`],
    ])('answers 400 errors.redirect for %s and stores nothing', async (_label, redirect) => {
      const email = uniqueEmail('redirect-check')

      const response = await postRequest({ email, redirect })

      expect(response.status).toBe(400)
      expect((response.body as { errors?: Record<string, unknown> }).errors).toHaveProperty(
        'redirect'
      )
      expect(await linkRows(email)).toEqual([])
    })

    it('stores a path with a query and a fragment byte for byte and verify returns it', async () => {
      const email = uniqueEmail('redirect-exact')
      const redirect = '/tenants/acme/members?tenant=acme&tab=2#x'
      const token = await issueTestLink(email, 'web', redirect)

      const response = await postVerify(token)

      expect(response.status).toBe(200)
      expect(verifyData(response).redirect).toBe(redirect)
    })
  })

  it('answers 429 with Retry-After past the IP budget', async () => {
    // Bodies that fail validation: they spend the IP budget (10 per 15 minutes) but mail nothing.
    for (let index = 0; index < 10; index += 1) {
      const response = await postRequest({})
      expect(response.status).toBe(400)
    }

    const limited = await postRequest({})

    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toMatch(/^\d+$/)
  })
})

describe('POST /auth/link/verify', () => {
  it('creates a verified account on first click and says isNewUser', async () => {
    const email = uniqueEmail('first-click')
    const token = await issueTestLink(email)

    const response = await postVerify(token)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const data = verifyData(response)
    expect(data.isNewUser).toBe(true)
    expect(data.user.email).toBe(email)
    expect(data.redirect).toBeNull()
    expect(data.accessToken).toEqual(expect.any(String))
    const cookieLines = response.headers['set-cookie'] as unknown as string[]
    expect(cookieLines.some((line) => line.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(true)

    const created = await userRepository.findByEmail(email)
    expect(created?.id).toBe(data.user.id)
    expect(created?.emailVerifiedAt).toBeInstanceOf(Date)
    const providers = await sql<{ provider: string; providerId: string }[]>`
      select provider, provider_id as "providerId" from auth_providers where user_id = ${data.user.id}
    `
    expect(providers).toEqual([{ provider: 'email', providerId: email }])
    expect(await refreshRows(data.user.id)).toEqual([{ revoked: false }])

    const events = eventsFor(data.user.id)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_signed_up', method: 'link' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_signed_in', method: 'link' })
    )
  })

  it('signs an existing account in with isNewUser false and returns the stored redirect', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('existing-signin') })
    const token = await issueTestLink(user.email, 'web', '/tenants/acme')

    const response = await postVerify(token)

    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.isNewUser).toBe(false)
    expect(data.user.id).toBe(user.id)
    expect(data.redirect).toBe('/tenants/acme')
    expect(await refreshRows(user.id)).toEqual([{ revoked: false }])
    expect(eventsFor(user.id).map((event) => event.type)).toEqual(['user_signed_in'])
  })

  it('verifies a never-verified account and revokes its earlier sessions', async () => {
    const user = await createTrackedUser({
      email: uniqueEmail('never-verified'),
      verified: false,
      hasPassword: true,
    })
    await issueRefreshToken(user.id, randomUUID())
    await authProviderRepository.create({
      userId: user.id,
      provider: 'email',
      providerId: user.email,
    })
    // A squatter's own Google link on the never-verified account.
    await authProviderRepository.create({
      userId: user.id,
      provider: 'google',
      providerId: randomUUID(),
    })
    const token = await issueTestLink(user.email)

    const response = await postVerify(token)

    expect(response.status).toBe(200)
    expect(verifyData(response).isNewUser).toBe(false)
    expect(await refreshRows(user.id)).toEqual([{ revoked: true }, { revoked: false }])
    const claimed = await userRepository.findById(user.id)
    expect(claimed?.emailVerifiedAt).toBeInstanceOf(Date)
    // A squatter's password and federated links on the address go once the mailbox is proven.
    expect(claimed?.passwordHash).toBeNull()
    const providers = await authProviderRepository.findByUser(user.id)
    expect(providers.map((provider) => provider.provider)).toEqual(['email'])
    expect(eventsFor(user.id).filter((event) => event.type === 'email_verified')).toHaveLength(1)
  })

  it('emits email_verified for an account the click created', async () => {
    const email = uniqueEmail('created-verified')
    const token = await issueTestLink(email)

    const response = await postVerify(token)

    expect(response.status).toBe(200)
    const types = eventsFor(verifyData(response).user.id).map((event) => event.type)
    expect(types.filter((type) => type === 'email_verified')).toHaveLength(1)
    expect(types).toContain('user_signed_up')
  })

  it('answers LINK_INVALID for unknown, used, expired and malformed tokens, identically', async () => {
    const usedToken = await issueTestLink(uniqueEmail('used'))
    const firstUse = await postVerify(usedToken)
    expect(firstUse.status).toBe(200)
    const expiredToken = await issueTestLink(uniqueEmail('expired'))
    await sql`
      update user_tokens set expires_at = now() - interval '1 minute'
      where token_hash = ${hashToken(expiredToken)}
    `

    const responses = [
      await postVerify(randomBytes(32).toString('base64url')),
      await postVerify(usedToken),
      await postVerify(expiredToken),
      await postVerify('not a token at all'),
    ]

    for (const response of responses) {
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: LINK_INVALID_CODE })
      expect(refusalBody(response)).toStrictEqual(refusalBody(responses[0] as Response))
    }
    expect(refusalBody(responses[0] as Response)).toMatchObject({
      message: 'This link has expired or was already used.',
    })
  })

  it('answers LINK_INVALID for a deactivated user and creates nothing', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('deactivated'), active: false })
    const token = await issueTestLink(user.email)

    const response = await postVerify(token)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: LINK_INVALID_CODE })
    expect(await refreshRows(user.id)).toEqual([])
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from users where lower(email) = ${user.email}
    `
    expect(row?.count).toBe(1)
  })

  it("creates a fresh account for a soft-deleted user's address", async () => {
    const email = uniqueEmail('soft-deleted')
    const deleted = await createTrackedUser({ email })
    await sql`update users set deleted_at = now() where id = ${deleted.id}`
    const token = await issueTestLink(email)

    const response = await postVerify(token)

    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.isNewUser).toBe(true)
    expect(data.user.id).not.toBe(deleted.id)
    expect(await refreshRows(deleted.id)).toEqual([])
  })

  it('issues one session when the same link is verified twice at once', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('twice') })
    const token = await issueTestLink(user.email)

    const responses = await Promise.all([postVerify(token), postVerify(token)])

    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 400,
    ])
    const loser = responses.find((response) => response.status === 400)
    expect(loser?.body).toMatchObject({ code: LINK_INVALID_CODE })
    const loserCookies = (loser?.headers['set-cookie'] as unknown as string[] | undefined) ?? []
    expect(loserCookies.some((line) => line.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(false)
    expect(await refreshRows(user.id)).toEqual([{ revoked: false }])
  })

  it('claims a never-verified account registered while the click was creating one', async () => {
    const email = uniqueEmail('register-race')
    const token = await issueTestLink(email)
    const seeded: { id?: string } = {}
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realCreate = UserRepository.prototype.create
    /**
     * Stands in for `UserRepository.create`: just before the click's insert, a
     * registration commits an unverified password account for the address, with a session.
     */
    const racingCreate: typeof realCreate = async function (this: UserRepository, ...arguments_) {
      const [values] = arguments_
      if (seeded.id === undefined && values.email === email) {
        const squatter = await realCreate.call(this, { email, passwordHash: 'not-a-real-hash' })
        seeded.id = squatter.id
        await issueRefreshToken(squatter.id, randomUUID())
      }
      return realCreate.apply(this, arguments_)
    }

    let response: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'create', racingCreate, async () => {
      response = await postVerify(token)
    })

    expect(response?.status).toBe(200)
    const data = verifyData(response as Response)
    expect(data.isNewUser).toBe(false)
    expect(data.user.id).toBe(seeded.id)
    const claimed = await userRepository.findById(seeded.id ?? '')
    expect(claimed?.passwordHash).toBeNull()
    expect(claimed?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(await refreshRows(seeded.id ?? '')).toEqual([{ revoked: true }, { revoked: false }])
  })

  it.each(['deleted', 'deactivated'] as const)(
    'answers LINK_INVALID with no session when the never-verified account is %s during its claim',
    async (change) => {
      const user = await createTrackedUser({
        email: uniqueEmail(`claim-${change}`),
        verified: false,
      })
      const token = await issueTestLink(user.email)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realLock = UserRepository.prototype.lockById
      const changed = { done: false }
      /**
       * Stands in for `UserRepository.lockById`: just before the claim's first
       * lock, a delete or a deactivation commits on another connection.
       */
      const changingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
        const [id, mode] = arguments_
        if (mode === 'no key update' && id === user.id && !changed.done) {
          changed.done = true
          await (change === 'deleted'
            ? sql`update users set deleted_at = now() where id = ${user.id}`
            : sql`update users set active = false where id = ${user.id}`)
        }
        return realLock.apply(this, arguments_)
      }

      let response: Response | undefined
      await withMutatedMethod(UserRepository.prototype, 'lockById', changingLock, async () => {
        response = await postVerify(token)
      })

      expect(response?.status).toBe(400)
      expect(response?.body).toMatchObject({ code: LINK_INVALID_CODE })
      const cookies = (response?.headers['set-cookie'] as unknown as string[] | undefined) ?? []
      expect(cookies.some((line) => line.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(false)
      expect(await refreshRows(user.id)).toEqual([])
    }
  )

  it('creates no account when full maintenance begins between the peek and the claim', async () => {
    const email = uniqueEmail('flip-full')
    const token = await issueTestLink(email)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realClaim = UserTokenRepository.prototype.claimOnce
    /**
     * Stands in for `claimOnce`: it claims, then switches the mode to `full` before the account is resolved.
     */
    const flippingClaim: typeof realClaim = async function (
      this: UserTokenRepository,
      ...arguments_
    ) {
      const claimed = await realClaim.apply(this, arguments_)
      await storeMaintenanceMode('full')
      await reloadMaintenanceMode()
      return claimed
    }

    let response: Response | undefined
    await withMutatedMethod(UserTokenRepository.prototype, 'claimOnce', flippingClaim, async () => {
      response = await postVerify(token)
    })

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
    expect(await userRepository.findByEmail(email)).toBeUndefined()
  })

  it('creates one account when two links for a new address are verified at once', async () => {
    const email = uniqueEmail('two-links')
    const first = await issueTestLink(email)
    // A second link revokes the first, so the race needs two live rows: re-open the first.
    const second = await issueTestLink(email)
    await sql`update user_tokens set revoked_at = null where token_hash = ${hashToken(first)}`

    const responses = await Promise.all([postVerify(first), postVerify(second)])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const data = responses.map((response) => verifyData(response))
    expect(data[0]?.user.id).toBe(data[1]?.user.id)
    expect(data.filter((entry) => entry.isNewUser)).toHaveLength(1)
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from users where lower(email) = ${email}
    `
    expect(row?.count).toBe(1)
  })

  it('revokes the session the browser presented', async () => {
    const email = uniqueEmail('presented')
    const earlier = await signInByLink(email)
    const token = await issueTestLink(email)

    const response = await postVerify(token, earlier.refreshCookie)

    expect(response.status).toBe(200)
    expect(await refreshRows(earlier.userId)).toEqual([{ revoked: true }, { revoked: false }])
  })

  it("refuses a disallowed Origin with the origin middleware's answer", async () => {
    const token = await issueTestLink(uniqueEmail('origin'))

    const response = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('Origin', 'https://evil.test')
      .send({ token })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    // The link was never presented, so it still signs in.
    const presented = await postVerify(token)
    expect(presented.status).toBe(200)
  })

  it('answers 415 for a form body', async () => {
    const token = await issueTestLink(uniqueEmail('form'))

    const response = await request(app)
      .post('/api/v1/auth/link/verify')
      .type('form')
      .send(`token=${token}`)

    expect(response.status).toBe(415)
  })

  it('answers a missing token with the validation 400, not LINK_INVALID', async () => {
    const response = await request(app).post('/api/v1/auth/link/verify').send({})

    expect(response.status).toBe(400)
    expect(response.body).not.toMatchObject({ code: LINK_INVALID_CODE })
    expect((response.body as { errors?: Record<string, unknown> }).errors).toHaveProperty('token')
  })

  it('refuses a non-staff user in full maintenance with MAINTENANCE_MODE and leaves the link usable', async () => {
    const user = await createTrackedUser({ email: uniqueEmail('full') })
    const token = await issueTestLink(user.email)
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    const refused = await postVerify(token)

    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
    await resetMaintenanceMode()
    await reloadMaintenanceMode()
    const allowed = await postVerify(token)
    expect(allowed.status).toBe(200)
    expect(verifyData(allowed).user.id).toBe(user.id)
  })

  it('refuses account creation in read_only with READ_ONLY_MODE, leaves the link usable, and signs an existing user in', async () => {
    const freshEmail = uniqueEmail('read-only-new')
    const freshToken = await issueTestLink(freshEmail)
    const existing = await createTrackedUser({ email: uniqueEmail('read-only-existing') })
    const existingToken = await issueTestLink(existing.email)
    await storeMaintenanceMode('read_only')
    await reloadMaintenanceMode()

    const refused = await postVerify(freshToken)
    const signedIn = await postVerify(existingToken)

    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ code: READ_ONLY_MODE_CODE })
    expect(await userRepository.findByEmail(freshEmail)).toBeUndefined()
    expect(signedIn.status).toBe(200)
    expect(verifyData(signedIn).user.id).toBe(existing.id)
    await resetMaintenanceMode()
    await reloadMaintenanceMode()
    const created = await postVerify(freshToken)
    expect(created.status).toBe(200)
    expect(verifyData(created).isNewUser).toBe(true)
  })
})
