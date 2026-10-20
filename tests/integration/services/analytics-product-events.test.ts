/**
 * @file Every product event's emit site, through the real services and the
 * subscribers createApp() registers, against the real per-worker Postgres:
 * sign-up and sign-in by an emailed link (a first link sign-in is also a
 * sign-up), Google sign-in (likewise), sign-out (once per session), email
 * verification (once), and the email webhook's `email_*` events (once per
 * stored provider event). Over HTTP, the row carries the browser session
 * the request named. Analytics is off under `.env.test`, so
 * `isAnalyticsEnabled` is mocked on here.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { claimNeverVerifiedAccount } from '@/services/account-claim.service'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { sql } from '@/services/database.service'
import { resetDomainEventSubscribers } from '@/services/domain-events.service'
import { getEmailWebhookAdapter, processEmailWebhook } from '@/services/email-webhook.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { registerOnboardingSubscribers } from '@/services/onboarding.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { revokeRefreshToken } from '@/services/session.service'
import { verifySignInLink } from '@/services/sign-in-link.service'
import { createInvitationRow } from '../../helpers/analytics-invitation'
import { clearOutbox, outboxRows, outboxRowsOf } from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackingRows, insertTestMessage, signedFakeBody } from '../../helpers/email-tracking'
import { SoftwareAuthenticator } from '../../helpers/passkey-authenticator'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { clearRateLimiter, issueTestLink } from '../../helpers/sign-in'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const PREFIX = `analytics-${randomUUID()}-`
// eslint-disable-next-line unicorn/no-null -- a non-staff user's platform role, as sent
const NONE = null
const createdTenantIds: string[] = []
const registeredEmails: string[] = []

beforeAll(() => {
  // Building the app is what registers the subscribers.
  resetDomainEventSubscribers()
  createApp()
})

beforeEach(async () => {
  analytics.isEnabled = true
  await clearOutbox()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearOutbox()
  await truncateAuditLogs()
  await deleteTrackingRows(PREFIX)
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (registeredEmails.length > 0) {
    await sql`delete from users where email = any(${registeredEmails})`
    registeredEmails.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  resetDomainEventSubscribers()
  registerOnboardingSubscribers()
  registerAnalyticsSubscribers()
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A fresh address under this file's prefix, deleted with its user after the test.
 */
function freshEmail(): string {
  const email = `${PREFIX}${randomUUID()}@example.test`
  registeredEmails.push(email)
  return email
}

/**
 * Signs `email` in by a fresh sign-in link, through the service, creating the
 * account on this click when the address has none.
 * @param email - The address.
 * @returns The sign-in's session, as `verifySignInLink` answers it.
 */
async function linkSignIn(email: string): Promise<Awaited<ReturnType<typeof verifySignInLink>>> {
  return verifySignInLink(await issueTestLink(email))
}

/**
 * A Google profile that reports `email` as verified, as `completeGoogleSignIn` receives it.
 */
function googleProfile(email: string): GoogleProfile {
  const id = randomUUID()
  return {
    provider: 'google',
    id,
    displayName: 'Probe User',
    profileUrl: `https://plus.google.com/${id}`,
    emails: [{ value: email, verified: true }],
    _raw: '{}',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-google-client-id',
      sub: id,
      iat: 0,
      exp: 0,
      email,
      email_verified: true,
    },
  }
}

describe('user_signed_up from a sign-in link', () => {
  it('is written by the click that creates the account, with the server-owned person properties', async () => {
    const email = freshEmail()

    await linkSignIn(email)

    const user = await userRepository.findByEmail(email)
    const rows = await outboxRowsOf('user_signed_up')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: user?.id,
      properties: {
        source: 'product',
        access: 'member',
        method: 'link',
        via_invitation: false,
        $set: {
          is_staff: false,
          platform_role: NONE,
          email_verified: true,
          auth_provider: 'link',
        },
        $set_once: { created_at: user?.createdAt.toISOString() },
      },
    })
    expect(rows[0]?.properties).not.toHaveProperty('$groups')
    expect(JSON.stringify(rows)).not.toContain(email)
  })

  it('writes nothing for an address that already has an account', async () => {
    const existing = await createTrackedUser()

    await linkSignIn(existing.email)

    expect(await outboxRowsOf('user_signed_up')).toEqual([])
  })

  it('reports via_invitation when a redeemable invitation named the address', async () => {
    const owner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Inviting Co',
      slug: `inviting-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    const email = freshEmail()
    await createInvitationRow(tenant.id, email.toUpperCase(), owner.id)

    await linkSignIn(email)

    const [row] = await outboxRowsOf('user_signed_up')
    expect(row?.properties).toMatchObject({ via_invitation: true })
  })
})

describe('user_signed_in', () => {
  it('is written by a link sign-in with the server-owned person properties', async () => {
    const { user } = await createTrackedStaff('admin')

    await linkSignIn(user.email)

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        event: 'user_signed_in',
        distinctId: user.id,
        properties: expect.objectContaining({
          method: 'link',
          $set: {
            is_staff: true,
            platform_role: 'admin',
            email_verified: true,
            auth_provider: 'link',
          },
        }) as unknown,
      }),
    ])
  })

  it('carries the browser session the request named in X-POSTHOG-SESSION-ID, and drops a malformed one', async () => {
    const user = await createTrackedUser()
    const app = createApp()
    const sessionId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

    const named = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('X-POSTHOG-SESSION-ID', sessionId)
      .send({ token: await issueTestLink(user.email) })
    const malformed = await request(app)
      .post('/api/v1/auth/link/verify')
      .set('X-POSTHOG-SESSION-ID', 'not-a-session')
      .send({ token: await issueTestLink(user.email) })

    expect([named.status, malformed.status]).toEqual([200, 200])
    const rows = await outboxRowsOf('user_signed_in')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.properties).toMatchObject({ $session_id: sessionId })
    expect(rows[1]?.properties).not.toHaveProperty('$session_id')
  })

  it('is written by a passkey sign-in with method passkey and auth_provider passkey', async () => {
    const app = createApp()
    const user = await createTrackedUser()
    const authenticator = new SoftwareAuthenticator()
    const token = recentAuthTokenFor(user)
    const asked = await request(app)
      .post('/api/v1/auth/passkeys/registration/options')
      .set('Authorization', `Bearer ${token}`)
      .send({ app: 'web' })
    await request(app)
      .post('/api/v1/auth/passkeys/registration/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({
        app: 'web',
        challengeId: (asked.body as { data: { challengeId: string } }).data.challengeId,
        response: authenticator.registrationResponse(
          (asked.body as { data: { options: { challenge: string } } }).data.options.challenge
        ),
      })
    await clearOutbox()
    await clearRateLimiter('passkey-sign-in')
    const options = await request(app).post('/api/v1/auth/passkeys/sign-in/options').send({})
    const body = options.body as { data: { challengeId: string; options: { challenge: string } } }

    const verified = await request(app)
      .post('/api/v1/auth/passkeys/sign-in/verify')
      .send({
        app: 'web',
        challengeId: body.data.challengeId,
        response: authenticator.assertionResponse(body.data.options.challenge),
      })

    expect(verified.status).toBe(200)
    const [row, ...rest] = await outboxRows()
    expect(rest).toEqual([])
    expect(row).toMatchObject({ event: 'user_signed_in', distinctId: user.id })
    expect(row?.properties).toMatchObject({ method: 'passkey', $set: { auth_provider: 'passkey' } })
  })

  it('is not written by a link that signs nobody in', async () => {
    await expect(verifySignInLink(`not-a-link-${randomUUID()}`)).rejects.toThrow()

    expect(await outboxRows()).toEqual([])
  })

  it('a first Google sign-in is a sign-up and a sign-in; a returning one is a sign-in only', async () => {
    const email = freshEmail()
    const profile = googleProfile(email)

    await completeGoogleSignIn(profile, 'web')
    const first = await outboxRows()
    expect(first.map((row) => row.event)).toEqual(['user_signed_up', 'user_signed_in'])
    expect(first[0]?.properties).toMatchObject({
      method: 'google',
      via_invitation: false,
      $set: { auth_provider: 'google', email_verified: true },
    })

    await clearOutbox()
    await completeGoogleSignIn(profile, 'web')
    const second = await outboxRows()
    expect(second.map((row) => row.event)).toEqual(['user_signed_in'])
    expect(second[0]?.properties).toMatchObject({ method: 'google' })
  })
})

describe('user_signed_out', () => {
  it('is written once per session, however often its cookie is presented', async () => {
    const user = await createTrackedUser()
    const { refreshToken } = await linkSignIn(user.email)
    await clearOutbox()

    await revokeRefreshToken(refreshToken.raw)
    await revokeRefreshToken(refreshToken.raw)
    await revokeRefreshToken(`not-a-token-${randomUUID()}`)

    expect(await outboxRows()).toEqual([
      expect.objectContaining({ event: 'user_signed_out', distinctId: user.id }),
    ])
  })

  it('is written once when two sign-outs race on one cookie', async () => {
    const user = await createTrackedUser()
    const { refreshToken } = await linkSignIn(user.email)
    await clearOutbox()

    await Promise.all([
      revokeRefreshToken(refreshToken.raw),
      revokeRefreshToken(refreshToken.raw),
      revokeRefreshToken(refreshToken.raw),
    ])

    expect(await outboxRowsOf('user_signed_out')).toHaveLength(1)
  })

  it('is not written for a session that had already lapsed', async () => {
    const user = await createTrackedUser()
    const { refreshToken } = await linkSignIn(user.email)
    await sql`update user_tokens set expires_at = now() - interval '1 hour' where user_id = ${user.id}`
    await clearOutbox()

    await revokeRefreshToken(refreshToken.raw)

    expect(await outboxRowsOf('user_signed_out')).toEqual([])
  })
})

describe('email_verified', () => {
  it('is written when a link verifies an unverified account, and not again', async () => {
    const user = await createTrackedUser({ verified: false })

    await linkSignIn(user.email)
    await linkSignIn(user.email)

    expect(await outboxRowsOf('email_verified')).toEqual([
      expect.objectContaining({ event: 'email_verified', distinctId: user.id }),
    ])
  })

  it('is written once when two claims verify the account at the same moment', async () => {
    const user = await createTrackedUser({ verified: false })

    await Promise.all([claimNeverVerifiedAccount(user.id), claimNeverVerifiedAccount(user.id)])

    expect(await outboxRowsOf('email_verified')).toHaveLength(1)
  })
})

describe('email_* from the email webhook', () => {
  const adapter = getEmailWebhookAdapter('fake')

  it('writes one event per stored provider event, in the webhook transaction', async () => {
    if (!adapter) throw new Error('setup: the fake adapter is served on APP_ENV local')
    const user = await createTrackedUser()
    const owner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Mailing Co',
      slug: `mailing-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    const message = await insertTestMessage(PREFIX, {
      templateKey: 'onboarding_reminder',
      userId: user.id,
      tenantId: tenant.id,
    })
    const delivered = { id: `evt-${randomUUID()}`, type: 'delivered', messageId: message.header }
    const { body, headers } = signedFakeBody([
      delivered,
      { type: 'bounced', bounceKind: 'soft', messageId: message.header },
    ])

    await processEmailWebhook(adapter, body, headers)
    const replay = signedFakeBody(delivered)
    await processEmailWebhook(adapter, replay.body, replay.headers)

    const rows = await outboxRows()
    expect(
      rows.map((row) => row.event).toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['email_bounced', 'email_delivered'])
    expect(rows.find((row) => row.event === 'email_bounced')).toMatchObject({
      distinctId: user.id,
      properties: {
        source: 'email',
        access: 'system',
        template_key: 'onboarding_reminder',
        message_id: message.id,
        bounce_kind: 'soft',
        $groups: { tenant: tenant.id },
      },
    })
    expect(JSON.stringify(rows)).not.toContain(message.recipient)
  })

  it('sends an event for a message with no user as a system event', async () => {
    if (!adapter) throw new Error('setup: the fake adapter is served on APP_ENV local')
    const message = await insertTestMessage(PREFIX, { templateKey: 'step_up_link' })
    const { body, headers } = signedFakeBody({ type: 'opened', messageId: message.header })

    await processEmailWebhook(adapter, body, headers)

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        event: 'email_opened',
        distinctId: 'system',
        properties: expect.objectContaining({ $process_person_profile: false }) as unknown,
      }),
    ])
  })
})

describe('while analytics is disabled', () => {
  it('no emit site writes a row', async () => {
    analytics.isEnabled = false
    const user = await createTrackedUser()

    await linkSignIn(user.email)
    await linkSignIn(freshEmail())

    expect(await outboxRows()).toEqual([])
  })
})
