/**
 * @file Every product event's emit site, through the real services and the
 * subscribers createApp() registers, against the real per-worker Postgres:
 * sign-up (inside the deferred register returns, created path only),
 * password and Google sign-in (a first Google sign-in is also a sign-up),
 * sign-out (once per session), password change and reset, email
 * verification (once), and the email webhook's `email_*` events (once per
 * stored provider event). Over HTTP, the row carries the browser session
 * the request named. Analytics is off under `.env.test`, so
 * `isAnalyticsEnabled` is mocked on here.
 */
import { randomUUID } from 'node:crypto'
import type { Profile as GoogleProfile } from 'passport-google-oauth20'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { changePassword, login, register, resetPassword } from '@/services/auth.service'
import { sql } from '@/services/database.service'
import { resetDomainEventSubscribers } from '@/services/domain-events.service'
import { getEmailWebhookAdapter, processEmailWebhook } from '@/services/email-webhook.service'
import { completeGoogleSignIn } from '@/services/google-auth.service'
import { registerOnboardingSubscribers } from '@/services/onboarding.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { issueToken, revokeRefreshToken } from '@/services/session.service'
import { verifyEmail } from '@/services/verification.service'
import { createInvitationRow } from '../../helpers/analytics-invitation'
import { clearOutbox, outboxRows, outboxRowsOf } from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackingRows, insertTestMessage, signedFakeBody } from '../../helpers/email-tracking'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  TEST_PASSWORD,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const PREFIX = `analytics-${randomUUID()}-`
const NEW_PASSWORD = 'a brand new passphrase 42'
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
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A fresh address under this file's prefix, cleaned up after the test.
 * @returns The address.
 */
function freshEmail(): string {
  const email = `${PREFIX}${randomUUID()}@example.test`
  registeredEmails.push(email)
  return email
}

/**
 * A verified user with a password.
 * @returns The user.
 */
async function passwordUser(): Promise<User> {
  return createTrackedUser({ hasPassword: true })
}

/**
 * A Google profile with a verified address.
 * @param email - The address Google reports.
 * @returns The profile.
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

describe('user_signed_up from register', () => {
  it('is written by the deferred work, after the reply, on the created path only', async () => {
    const email = freshEmail()

    const followUp = await register({ email, password: TEST_PASSWORD, app: 'web' })
    expect(await outboxRows()).toEqual([])

    await followUp()

    const user = await userRepository.findByEmail(email)
    const rows = await outboxRowsOf('user_signed_up')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: user?.id,
      properties: {
        source: 'product',
        access: 'member',
        method: 'password',
        via_invitation: false,
        $set: {
          is_staff: false,
          platform_role: NONE,
          email_verified: false,
          auth_provider: 'password',
        },
        $set_once: { created_at: user?.createdAt.toISOString() },
      },
    })
    expect(rows[0]?.properties).not.toHaveProperty('$groups')
    expect(JSON.stringify(rows)).not.toContain(email)
  })

  it('writes nothing for an address already taken', async () => {
    const existing = await passwordUser()

    const followUp = await register({ email: existing.email, password: TEST_PASSWORD, app: 'web' })
    await followUp()

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

    const followUp = await register({ email, password: TEST_PASSWORD, app: 'web' })
    await followUp()

    const [row] = await outboxRowsOf('user_signed_up')
    expect(row?.properties).toMatchObject({ via_invitation: true })
  })
})

describe('user_signed_in', () => {
  it('is written by a password login with the server-owned person properties', async () => {
    const { user } = await createTrackedStaff('admin', { hasPassword: true })

    await login({ email: user.email, password: TEST_PASSWORD })

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        event: 'user_signed_in',
        distinctId: user.id,
        properties: expect.objectContaining({
          method: 'password',
          $set: {
            is_staff: true,
            platform_role: 'admin',
            email_verified: true,
            auth_provider: 'password',
          },
        }) as unknown,
      }),
    ])
  })

  it('carries the browser session the request named in X-POSTHOG-SESSION-ID, and drops a malformed one', async () => {
    const user = await passwordUser()
    const app = createApp()
    const sessionId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

    const named = await request(app)
      .post('/api/v1/auth/login')
      .set('X-POSTHOG-SESSION-ID', sessionId)
      .send({ email: user.email, password: TEST_PASSWORD })
    const malformed = await request(app)
      .post('/api/v1/auth/login')
      .set('X-POSTHOG-SESSION-ID', 'not-a-session')
      .send({ email: user.email, password: TEST_PASSWORD })

    expect([named.status, malformed.status]).toEqual([200, 200])
    const rows = await outboxRowsOf('user_signed_in')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.properties).toMatchObject({ $session_id: sessionId })
    expect(rows[1]?.properties).not.toHaveProperty('$session_id')
  })

  it('is not written by a failed login', async () => {
    const user = await passwordUser()

    await expect(login({ email: user.email, password: 'wrong password here' })).rejects.toThrow()

    expect(await outboxRows()).toEqual([])
  })

  it('a first Google sign-in is a sign-up and a sign-in; a returning one is a sign-in only', async () => {
    const email = freshEmail()
    const profile = googleProfile(email)

    await completeGoogleSignIn(profile)
    const first = await outboxRows()
    expect(first.map((row) => row.event)).toEqual(['user_signed_up', 'user_signed_in'])
    expect(first[0]?.properties).toMatchObject({
      method: 'google',
      via_invitation: false,
      $set: { auth_provider: 'google', email_verified: true },
    })

    await clearOutbox()
    await completeGoogleSignIn(profile)
    const second = await outboxRows()
    expect(second.map((row) => row.event)).toEqual(['user_signed_in'])
    expect(second[0]?.properties).toMatchObject({ method: 'google' })
  })
})

describe('user_signed_out', () => {
  it('is written once per session, however often its cookie is presented', async () => {
    const user = await passwordUser()
    const { refreshToken } = await login({ email: user.email, password: TEST_PASSWORD })
    await clearOutbox()

    await revokeRefreshToken(refreshToken.raw)
    await revokeRefreshToken(refreshToken.raw)
    await revokeRefreshToken(`not-a-token-${randomUUID()}`)

    expect(await outboxRows()).toEqual([
      expect.objectContaining({ event: 'user_signed_out', distinctId: user.id }),
    ])
  })
})

describe('password events', () => {
  it('password_changed is written by a successful change only', async () => {
    const user = await passwordUser()

    await expect(
      changePassword(user.id, undefined, {
        currentPassword: 'not the password',
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toThrow()
    expect(await outboxRows()).toEqual([])

    await changePassword(user.id, undefined, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    })

    expect(await outboxRows()).toEqual([
      expect.objectContaining({ event: 'password_changed', distinctId: user.id }),
    ])
  })

  it('password_reset_completed is written by a reset', async () => {
    const user = await passwordUser()
    const issued = await issueToken(user.id, 'password_reset', 60_000)

    await resetPassword({ token: issued.raw, password: NEW_PASSWORD })

    expect(await outboxRows()).toEqual([
      expect.objectContaining({ event: 'password_reset_completed', distinctId: user.id }),
    ])
  })
})

describe('email_verified', () => {
  it('is written when a link verifies an unverified account, and not again', async () => {
    const user = await createTrackedUser({ hasPassword: true, verified: false })
    const first = await issueToken(user.id, 'email_verification', 60_000)

    await verifyEmail(first.raw, TEST_PASSWORD)
    const second = await issueToken(user.id, 'email_verification', 60_000)
    await verifyEmail(second.raw, TEST_PASSWORD)

    expect(await outboxRows()).toEqual([
      expect.objectContaining({ event: 'email_verified', distinctId: user.id }),
    ])
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
      templateKey: 'tenant_invitation',
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
        template_key: 'tenant_invitation',
        message_id: message.id,
        bounce_kind: 'soft',
        $groups: { tenant: tenant.id },
      },
    })
    expect(JSON.stringify(rows)).not.toContain(message.recipient)
  })

  it('sends an event for a message with no user as a system event', async () => {
    if (!adapter) throw new Error('setup: the fake adapter is served on APP_ENV local')
    const message = await insertTestMessage(PREFIX, { templateKey: 'registration_attempt' })
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
    const user = await passwordUser()

    await login({ email: user.email, password: TEST_PASSWORD })
    const followUp = await register({ email: freshEmail(), password: TEST_PASSWORD, app: 'web' })
    await followUp()

    expect(await outboxRows()).toEqual([])
  })
})
