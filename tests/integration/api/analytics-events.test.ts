/**
 * @file The server event pipeline end to end: real requests through the real
 * app write outbox rows, `drainAnalyticsOutbox` sends them, and the fake
 * PostHog records exactly what left the process. An in-process OpenTelemetry
 * SDK (`tests/helpers/trace-capture.ts`, with tracing.ts's own HTTP
 * configuration) parents each request's span on the `traceparent` the test
 * sends, so every event is matched to the request that caused it by
 * `trace_id`. Covers the sign-up, sign-in, tenant, invite and accept
 * sequence, the email webhook's `email_*` events, a resend after a lost
 * acknowledgement (same `uuid`, `timestamp`, `event` and `distinct_id`, which
 * PostHog deduplicates on), and that no address or name reaches PostHog.
 * Analytics is enabled for this file through a mocked `getEnv()`. No Worker
 * runs: the drains are called directly, and mail is read off the queues.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Express } from 'express'
import type { Test } from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const capture = await vi.hoisted(async () => {
  const { HTTP_INSTRUMENTATION_CONFIG } = await import('@/observability/tracing')
  const { startTraceCapture } = await import('../../helpers/trace-capture')
  return startTraceCapture(HTTP_INSTRUMENTATION_CONFIG)
})

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
    }),
  }
})

const { createApp } = await import('@/app')
const { ANALYTICS_LEASE_SECONDS } = await import('@/constants/analytics.constants')
const { AnalyticsOutboxRepository } = await import('@/repositories/analytics-outbox.repository')
const { UserRepository } = await import('@/repositories/user.repository')
const { drainAnalyticsOutbox } = await import('@/services/analytics/analytics-drain.service')
const { sql } = await import('@/services/database.service')
const { closeQueue, getEmailQueue, getNotificationQueue } = await import('@/services/queue.service')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { deleteTrackingRows, insertTestMessage, signedFakeBody } =
  await import('../../helpers/email-tracking')
const { startFakePosthog } = await import('../../helpers/fake-posthog')
const { withMutatedMethod } = await import('../../helpers/mutate')
const { waitForInvitationEmail, waitForVerificationToken } =
  await import('../../helpers/queue-jobs')
const { testRefreshCookie } = await import('../../helpers/refresh-cookie')
const { request } = await import('../../helpers/request')
const { waitUntil } = await import('../../helpers/timing')

type FakePosthog = Awaited<ReturnType<typeof startFakePosthog>>
type BatchEvent = FakePosthog['batches'][number][number]

const PASSWORD = 'correct horse battery staple'
const PROBE_FIRST_NAME = 'Pii'
const PROBE_LAST_NAME = 'Probe'
const HEX_16 = /^[\da-f]{16}$/
// eslint-disable-next-line unicorn/no-null -- JSON null, as the event carries it for "not staff"
const NOT_STAFF = null
// The longest backoff (600 s) plus the lease: past it, every leased row is claimable again.
const PAST_LEASE_AND_BACKOFF_MS = (ANALYTICS_LEASE_SECONDS + 600 + 1) * 1000
const TRACKING_PREFIX = `analytics-events-${randomUUID()}-`
// Six bcrypt operations at cost 12 (two hashes, four compares) and nine requests: three times a single-login test's work, so three times the suite's 20 s.
const FLOW_TIMEOUT_MS = 60_000

const { name: REFRESH_TOKEN_COOKIE_NAME } = testRefreshCookie()
const userRepository = new UserRepository()
const state: {
  posthog?: FakePosthog
  app?: Express
  userIds: string[]
  tenantIds: string[]
} = { userIds: [], tenantIds: [] }

/**
 * The running fake and the app.
 * @returns Both.
 */
function running(): { posthog: FakePosthog; app: Express } {
  if (!state.posthog || !state.app) throw new Error('setup did not run')
  return { posthog: state.posthog, app: state.app }
}

/**
 * Send a request under a fresh W3C trace, so its events can be found by `trace_id`.
 * @param test - The request, before it is sent.
 * @returns The trace id the server span is parented on, and the response.
 */
async function traced(
  test: Test
): Promise<{ traceId: string; status: number; body: unknown; cookies: string[] }> {
  const traceId = randomBytes(16).toString('hex')
  const response = await test.set(
    'traceparent',
    `00-${traceId}-${randomBytes(8).toString('hex')}-01`
  )
  return {
    traceId,
    status: response.status,
    body: response.body as unknown,
    cookies: (response.headers['set-cookie'] as string[] | undefined) ?? [],
  }
}

/**
 * Drain until the outbox is empty, then return every event PostHog received.
 * @returns The events, in the order they were sent.
 */
async function drainAll(): Promise<BatchEvent[]> {
  for (let drain = 0; drain < 10; drain += 1) {
    const result = await drainAnalyticsOutbox()
    if (result.sent === 0) break
  }
  return running().posthog.batches.flat()
}

/**
 * The events one request caused, oldest first.
 * @param events - Every event sent.
 * @param traceId - The request's trace id.
 * @returns Its events.
 */
function eventsOf(events: BatchEvent[], traceId: string): BatchEvent[] {
  return events.filter((event) => event.properties.trace_id === traceId)
}

/**
 * The event names one request caused, oldest first.
 * @param events - Every event sent.
 * @param traceId - The request's trace id.
 * @returns Their names.
 */
function namesOf(events: BatchEvent[], traceId: string): string[] {
  return eventsOf(events, traceId).map((event) => event.event)
}

/**
 * Wait until a product event the request's deferred work enqueues after the reply is in the outbox.
 * @param event - The event name.
 * @param distinctId - Its user.
 * @returns Resolves once the row exists.
 */
async function waitForOutboxRow(event: string, distinctId: string): Promise<void> {
  await waitUntil(
    async () => {
      const rows = await sql`
        select 1 from analytics_outbox where event = ${event} and distinct_id = ${distinctId}`
      return rows.length > 0
    },
    { message: `${event} reached the outbox` }
  )
}

/**
 * Register, verify and sign in a user through the API, each under its own trace.
 * @param email - The address.
 * @param sessionId - A browser session to send on the sign-in as `X-POSTHOG-SESSION-ID`.
 * @returns The user id, the access token, the refresh cookie and each step's trace id.
 */
async function signUpVerifyAndSignIn(
  email: string,
  sessionId?: string
): Promise<{
  userId: string
  accessToken: string
  refreshCookie: string
  traces: { signUp: string; verify: string; signIn: string }
}> {
  const { app } = running()
  const signUp = await traced(
    request(app).post('/api/v1/auth/register').send({
      email,
      password: PASSWORD,
      firstName: PROBE_FIRST_NAME,
      lastName: PROBE_LAST_NAME,
    })
  )
  expect(signUp.status).toBe(202)
  const user = await userRepository.findByEmail(email)
  if (!user) throw new Error(`no user for ${email}`)
  state.userIds.push(user.id)
  await waitForOutboxRow('user_signed_up', user.id)

  const token = await waitForVerificationToken(user.id)
  const verify = await traced(
    request(app).post('/api/v1/auth/verify-email').send({ token, password: PASSWORD })
  )
  expect(verify.status).toBe(200)

  const signInRequest = request(app).post('/api/v1/auth/login')
  if (sessionId !== undefined) void signInRequest.set('X-POSTHOG-SESSION-ID', sessionId)
  const signIn = await traced(signInRequest.send({ email, password: PASSWORD }))
  expect(signIn.status).toBe(200)
  const accessToken = (signIn.body as { data: { accessToken: string } }).data.accessToken
  const refreshCookie = signIn.cookies.find((cookie) =>
    cookie.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`)
  )
  if (refreshCookie === undefined) throw new Error('sign-in set no refresh cookie')
  return {
    userId: user.id,
    accessToken,
    refreshCookie,
    traces: { signUp: signUp.traceId, verify: verify.traceId, signIn: signIn.traceId },
  }
}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  state.app = createApp()
})

beforeEach(async () => {
  await sql`delete from analytics_outbox`
  const { posthog } = running()
  posthog.batches.length = 0
  posthog.requests.length = 0
  posthog.respondWith(200)
})

afterAll(async () => {
  await sql`delete from analytics_outbox`
  await deleteTrackingRows(TRACKING_PREFIX)
  await truncateAuditLogs()
  if (state.tenantIds.length > 0) await sql`delete from tenants where id = any(${state.tenantIds})`
  if (state.userIds.length > 0) await sql`delete from users where id = any(${state.userIds})`
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
  await state.posthog?.close()
  await capture.stop()
})

describe('sign up, sign in, create a tenant, invite, sign up through the invitation, accept', () => {
  it(
    'sends exactly the expected events, each carrying its request’s trace_id and the right $groups',
    async () => {
      const { app, posthog } = running()
      const ownerEmail = `analytics-owner-${randomUUID()}@example.test`
      const inviteeEmail = `analytics-invitee-${randomUUID()}@example.test`

      const owner = await signUpVerifyAndSignIn(ownerEmail)
      const slug = `analytics-${randomUUID().slice(0, 8)}`
      const tenantCreation = await traced(
        request(app)
          .post('/api/v1/tenants')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ name: 'Analytics Workspace', slug })
      )
      expect(tenantCreation.status).toBe(201)
      const tenantId = (tenantCreation.body as { data: { id: string } }).data.id
      state.tenantIds.push(tenantId)

      const invite = await traced(
        request(app)
          .post(`/api/v1/tenants/${slug}/invitations`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ email: inviteeEmail, role: 'editor' })
      )
      expect(invite.status).toBe(202)
      const invitation = await waitForInvitationEmail(inviteeEmail)

      const invitee = await signUpVerifyAndSignIn(inviteeEmail)
      const accept = await traced(
        request(app)
          .post('/api/v1/invitations/accept')
          .set('Authorization', `Bearer ${invitee.accessToken}`)
          .send({ token: invitation.token })
      )
      expect(accept.status).toBe(200)

      const events = await drainAll()

      expect(namesOf(events, owner.traces.signUp)).toEqual(['user_signed_up'])
      expect(namesOf(events, owner.traces.verify)).toEqual(['email_verified'])
      expect(namesOf(events, owner.traces.signIn)).toEqual(['user_signed_in'])
      // The tenant's group row is built in the same savepoint as its audit event, so it shares the trace.
      expect(namesOf(events, tenantCreation.traceId)).toEqual(['tenant_created', '$groupidentify'])
      expect(namesOf(events, invite.traceId)).toEqual([
        'invitation_created',
        'onboarding_step_completed',
      ])
      expect(namesOf(events, invitee.traces.signUp)).toEqual(['user_signed_up'])
      expect(namesOf(events, invitee.traces.verify)).toEqual(['email_verified'])
      expect(namesOf(events, invitee.traces.signIn)).toEqual(['user_signed_in'])
      expect(namesOf(events, accept.traceId)).toEqual([
        'invitation_accepted',
        'onboarding_step_completed',
      ])

      // Who each event is about, and its tenant group: user-level events carry none.
      expect(eventsOf(events, owner.traces.signUp)[0]).toMatchObject({
        distinct_id: owner.userId,
        properties: {
          source: 'product',
          app: 'api',
          method: 'password',
          via_invitation: false,
          $set: { is_staff: false, platform_role: NOT_STAFF, email_verified: false },
        },
      })
      expect(eventsOf(events, invitee.traces.signUp)[0]).toMatchObject({
        distinct_id: invitee.userId,
        properties: { via_invitation: true },
      })
      expect(eventsOf(events, owner.traces.signIn)[0]).toMatchObject({
        distinct_id: owner.userId,
        properties: { method: 'password', $set: { is_staff: false, email_verified: true } },
      })
      for (const traceId of [
        owner.traces.signUp,
        owner.traces.verify,
        owner.traces.signIn,
        invitee.traces.signUp,
        invitee.traces.verify,
        invitee.traces.signIn,
      ]) {
        expect(eventsOf(events, traceId)[0]?.properties.$groups).toBeUndefined()
      }
      expect(eventsOf(events, tenantCreation.traceId)[0]).toMatchObject({
        distinct_id: owner.userId,
        properties: {
          source: 'audit',
          access: 'member',
          target_type: 'tenant',
          target_id: tenantId,
          $groups: { tenant: tenantId },
        },
      })
      expect(eventsOf(events, tenantCreation.traceId)[0]?.properties).not.toHaveProperty('name')
      expect(eventsOf(events, tenantCreation.traceId)[0]?.properties).not.toHaveProperty('slug')
      expect(eventsOf(events, invite.traceId)).toMatchObject([
        {
          distinct_id: owner.userId,
          properties: {
            source: 'audit',
            role: 'editor',
            email_domain: 'example.test',
            $groups: { tenant: tenantId },
          },
        },
        {
          distinct_id: owner.userId,
          properties: {
            source: 'product',
            step_key: 'invite_teammate',
            how: 'auto',
            required: true,
            $groups: { tenant: tenantId },
          },
        },
      ])
      expect(eventsOf(events, accept.traceId)).toMatchObject([
        {
          distinct_id: invitee.userId,
          properties: { source: 'audit', role: 'editor', $groups: { tenant: tenantId } },
        },
        {
          distinct_id: invitee.userId,
          properties: {
            step_key: 'teammate_joined',
            how: 'auto',
            required: false,
            $groups: { tenant: tenantId },
          },
        },
      ])

      // The tenant's group properties, read from the tenant row when the drainer sent the marker.
      expect(events.filter((event) => event.event === '$groupidentify')).toMatchObject([
        {
          properties: {
            $group_type: 'tenant',
            $group_key: tenantId,
            $group_set: { name: 'Analytics Workspace', status: 'active' },
          },
        },
      ])

      // Every traced event but a group marker (which carries the trace only) has the server span's own id beside the client's trace id.
      const tracedEvents = events.filter(
        (sent) => sent.properties.trace_id !== undefined && sent.event !== '$groupidentify'
      )
      expect(tracedEvents.length).toBeGreaterThan(0)
      for (const event of tracedEvents) expect(event.properties.span_id).toMatch(HEX_16)

      // Nothing that names a person left the process.
      const sentBodies = posthog.requests
        .map((received) => received.body.toString('utf8'))
        .join('\n')
      for (const pii of [ownerEmail, inviteeEmail, PROBE_FIRST_NAME, PROBE_LAST_NAME]) {
        expect(sentBodies).not.toContain(pii)
      }
    },
    FLOW_TIMEOUT_MS
  )
})

describe('browser session attribution', () => {
  it(
    'puts $session_id on the user’s own events, including the sign-in, and never on the tenant group row',
    async () => {
      const { app } = running()
      const signInSession = randomUUID()
      const apiSession = randomUUID()
      const owner = await signUpVerifyAndSignIn(
        `analytics-session-${randomUUID()}@example.test`,
        signInSession
      )
      const tenantCreation = await traced(
        request(app)
          .post('/api/v1/tenants')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .set('X-POSTHOG-SESSION-ID', apiSession)
          .send({ name: 'Session Workspace', slug: `session-${randomUUID().slice(0, 8)}` })
      )
      expect(tenantCreation.status).toBe(201)
      state.tenantIds.push((tenantCreation.body as { data: { id: string } }).data.id)

      const events = await drainAll()
      // The sign-in has no authenticated user yet, so its session is the user's own.
      expect(eventsOf(events, owner.traces.signIn)[0]?.properties.$session_id).toBe(signInSession)
      const [created, groupIdentify] = eventsOf(events, tenantCreation.traceId)
      expect(created?.event).toBe('tenant_created')
      expect(created?.properties.$session_id).toBe(apiSession)
      expect(groupIdentify?.event).toBe('$groupidentify')
      expect(groupIdentify?.properties).not.toHaveProperty('$session_id')
      expect(groupIdentify?.properties).not.toHaveProperty('$process_person_profile')
    },
    FLOW_TIMEOUT_MS
  )

  it(
    'keeps the session through a :slug route and on the user’s own sign-out',
    async () => {
      const { app } = running()
      const owner = await signUpVerifyAndSignIn(`analytics-slug-${randomUUID()}@example.test`)
      const slug = `slug-${randomUUID().slice(0, 8)}`
      const tenantCreation = await traced(
        request(app)
          .post('/api/v1/tenants')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ name: 'Slug Workspace', slug })
      )
      expect(tenantCreation.status).toBe(201)
      state.tenantIds.push((tenantCreation.body as { data: { id: string } }).data.id)

      // resolveTenant replaces the request store with enterWith; the user must survive it.
      const slugSession = randomUUID()
      const invite = await traced(
        request(app)
          .post(`/api/v1/tenants/${slug}/invitations`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .set('X-POSTHOG-SESSION-ID', slugSession)
          .send({ email: `analytics-slug-invitee-${randomUUID()}@example.test`, role: 'editor' })
      )
      expect(invite.status).toBe(202)

      // Logout has no access token: the refresh cookie identifies the user.
      const signOutSession = randomUUID()
      const signOut = await traced(
        request(app)
          .post('/api/v1/auth/logout')
          .set('Cookie', owner.refreshCookie)
          .set('X-POSTHOG-SESSION-ID', signOutSession)
      )
      expect(signOut.status).toBe(200)

      const events = await drainAll()
      const [invitationCreated] = eventsOf(events, invite.traceId)
      expect(invitationCreated?.event).toBe('invitation_created')
      expect(invitationCreated?.distinct_id).toBe(owner.userId)
      expect(invitationCreated?.properties.$session_id).toBe(slugSession)
      const [signedOut] = eventsOf(events, signOut.traceId)
      expect(signedOut?.event).toBe('user_signed_out')
      expect(signedOut?.distinct_id).toBe(owner.userId)
      expect(signedOut?.properties.$session_id).toBe(signOutSession)
    },
    FLOW_TIMEOUT_MS
  )
})

describe('email webhook events', () => {
  it('sends one email_<type> per stored event, with the template, message, user and tenant, never the recipient', async () => {
    const { app } = running()
    const userId = randomUUID()
    const tenantId = randomUUID()
    const message = await insertTestMessage(TRACKING_PREFIX, {
      templateKey: 'onboarding_reminder',
      userId,
      tenantId,
    })
    const anonymous = await insertTestMessage(TRACKING_PREFIX)

    for (const type of ['delivered', 'opened', 'clicked'] as const) {
      const { body, headers } = signedFakeBody({ type, messageId: message.header })
      const response = await request(app)
        .post('/api/v1/webhooks/email/fake')
        .set(headers)
        .send(body.toString('utf8'))
      expect(response.status).toBe(200)
    }
    const { body, headers } = signedFakeBody({ type: 'delivered', messageId: anonymous.header })
    await request(app).post('/api/v1/webhooks/email/fake').set(headers).send(body.toString('utf8'))

    // Only this test's messages: an earlier test's late requests must not count here.
    const sent = await drainAll()
    const events = sent.filter((event) =>
      [message.id, anonymous.id].includes(String(event.properties.message_id))
    )

    expect(events.map((event) => [event.event, event.distinct_id])).toEqual([
      ['email_delivered', userId],
      ['email_opened', userId],
      ['email_clicked', userId],
      ['email_delivered', 'system'],
    ])
    expect(events[0]?.properties).toMatchObject({
      source: 'email',
      template_key: 'onboarding_reminder',
      message_id: message.id,
      $groups: { tenant: tenantId },
    })
    expect(events[3]?.properties).toMatchObject({ $process_person_profile: false })
    expect(events[3]?.properties.$groups).toBeUndefined()
    const sentJson = JSON.stringify(sent)
    expect(sentJson).not.toContain(message.recipient)
    expect(sentJson).not.toContain(anonymous.recipient)
  })
})

describe('a resend after a lost acknowledgement', () => {
  it('carries the same uuid, timestamp, event, distinct_id and properties, which PostHog deduplicates on', async () => {
    const { app, posthog } = running()
    const message = await insertTestMessage(TRACKING_PREFIX, { userId: randomUUID() })
    const { body, headers } = signedFakeBody({ type: 'delivered', messageId: message.header })
    await request(app).post('/api/v1/webhooks/email/fake').set(headers).send(body.toString('utf8'))
    const now = new Date()

    // PostHog acknowledged, then the delete failed: the crash between ack and delete.
    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'deleteByIds',
      () => Promise.reject(new Error('connection lost')),
      async () => {
        await expect(drainAnalyticsOutbox(now)).rejects.toThrow('connection lost')
      }
    )
    const pending = await sql`
      select id from analytics_outbox where properties->>'message_id' = ${message.id}`
    expect(pending).toHaveLength(1)

    const later = new Date(now.getTime() + PAST_LEASE_AND_BACKOFF_MS)
    await expect(drainAnalyticsOutbox(later)).resolves.toMatchObject({ sent: 1 })

    const [first, resent] = posthog.batches.map((batch) =>
      batch.filter((event) => event.properties.message_id === message.id)
    )
    expect(first).toHaveLength(1)
    expect(resent).toEqual(first)
    expect(
      await sql`select id from analytics_outbox where properties->>'message_id' = ${message.id}`
    ).toHaveLength(0)
  })
})
