/**
 * @file Apex sign-in links admit staff only. A request mails a link to a
 * staff member; any other address gets nothing, except an address holding a
 * pending staff invitation, which gets that invitation again (outside its
 * resend cooldown) instead of a link. Every address gets the one fixed 202.
 * A verify reads the frontend from the link's row, never the request, and
 * an Apex link reaches only an existing staff account. The follow-up's
 * effects are asserted by awaiting it directly (`requestSignInLink`), never
 * by waiting on the clock.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { LINK_INVALID_CODE } from '@/constants/auth.constants'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { db, sql } from '@/services/database.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { requestSignInLink } from '@/services/sign-in-link.service'
import { startEmailWorker } from '@/workers/email.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { issueTestLink } from '../../helpers/sign-in'
import { waitUntil } from '../../helpers/timing'

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()

/**
 * The invitation mail is queued here, so the file runs its own email Worker
 * and empties the queue afterwards; `createApp()` starts none.
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

const HOUR_MS = 60 * 60 * 1000

/**
 * Every address this file used, lowercased, for `afterEach` to delete the
 * rows written for it.
 */
const usedEmails: string[] = []

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test, for reading rows while debugging.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `apex-link-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * How many sign-in link rows one address holds.
 * @param email - The address.
 * @returns The count of `user_tokens` rows with purpose `sign_in_link`.
 */
async function linkRowCount(email: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens
    where email = ${email.toLowerCase()} and purpose = 'sign_in_link'
  `
  return row?.count ?? 0
}

/**
 * How many messages of one template an address was sent.
 * @param email - The address.
 * @param templateKey - The template.
 * @returns The count of `email_messages` rows.
 */
async function messageCount(email: string, templateKey: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from email_messages
    where recipient = ${email.toLowerCase()} and template_key = ${templateKey}
  `
  return row?.count ?? 0
}

/**
 * The columns of an invitation the resend rewrites.
 */
interface InvitationState {
  tokenHash: string
  lastSentAt: string | null
  expiresAt: string
}

/**
 * Read an invitation's token hash, last send and expiry, as text so two
 * reads compare to the microsecond.
 * @param id - The invitation.
 * @returns Its state.
 */
async function invitationState(id: string): Promise<InvitationState> {
  const [row] = await sql<InvitationState[]>`
    select token_hash as "tokenHash", last_sent_at::text as "lastSentAt", expires_at::text as "expiresAt"
    from tenant_invitations where id = ${id}
  `
  if (!row) throw new Error(`invitation ${id} is gone`)
  return row
}

/**
 * A pending viewer invitation to the platform tenant for `email`, sent by a
 * fresh staff owner, its last send moved `lastSentAgoMs` into the past.
 * @param email - The invited address.
 * @param lastSentAgoMs - How long ago it was last mailed.
 * @param expiresInMs - How long it has left; a day by default.
 * @returns The invitation's id.
 */
async function staffInvitationFor(
  email: string,
  lastSentAgoMs: number,
  expiresInMs = 24 * HOUR_MS
): Promise<string> {
  const { user: inviter } = await createTrackedStaff('owner')
  const platform = await platformTenant()
  const rawToken = randomBytes(32).toString('base64url')
  const created = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: platform.id,
        email,
        role: 'viewer',
        tokenHash: hashToken(rawToken),
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
      tx
    )
  )
  const lastSentAt = new Date(Date.now() - lastSentAgoMs)
  await sql`
    update tenant_invitations set last_sent_at = ${lastSentAt.toISOString()}::timestamptz
    where id = ${created.id}
  `
  return created.id
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
 * @param body - The JSON body.
 * @returns The response.
 */
function postVerify(body: Record<string, unknown>): Promise<Response> {
  return request(app).post('/api/v1/auth/link/verify').send(body)
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

/**
 * The newest `invitation.resent` audit row for an invitation.
 * @param invitationId - The invitation.
 * @returns Its actor kind, access and metadata, or undefined.
 */
async function resentAudit(
  invitationId: string
): Promise<{ actorKind: string; access: string; metadata: Record<string, unknown> } | undefined> {
  const [row] = await sql<
    { actorKind: string; access: string; metadata: Record<string, unknown> }[]
  >`
    select actor_kind as "actorKind", access, metadata from audit_logs
    where action = 'invitation.resent' and target_id = ${invitationId}
    order by occurred_at desc limit 1
  `
  return row
}

beforeEach(async () => {
  await clearLimiter('sign-in-link-request')
  await clearLimiter('sign-in-link-verify')
})

afterEach(async () => {
  await truncateAuditLogs()
  if (usedEmails.length > 0) {
    await sql`delete from tenant_invitations where lower(email) = any(${usedEmails})`
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

describe('POST /auth/link/request on Apex', () => {
  it('mails an apex link to an existing staff member', async () => {
    const { user } = await createTrackedStaff('viewer', { email: uniqueEmail('staff') })

    await requestSignInLink({ email: user.email, app: 'apex' })()

    const [row] = await sql<{ app: string }[]>`
      select app from user_tokens where email = ${user.email} and purpose = 'sign_in_link'
    `
    expect(row?.app).toBe('apex')
    expect(await messageCount(user.email, 'sign_in_link')).toBe(1)
  })

  it('mails nothing to a non-staff address and answers the same 202', async () => {
    const customer = await createTrackedUser({ email: uniqueEmail('customer') })
    const unknown = uniqueEmail('unknown')

    for (const email of [customer.email, unknown]) {
      await requestSignInLink({ email, app: 'apex' })()
      expect(await linkRowCount(email)).toBe(0)
      expect(await messageCount(email, 'sign_in_link')).toBe(0)
      expect(await messageCount(email, 'tenant_invitation')).toBe(0)

      const response = await postRequest({ email, app: 'apex' })
      expect(response.status).toBe(202)
      expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
    }
  })

  it('resends a pending staff invitation instead of a sign-in link', async () => {
    const email = uniqueEmail('invitee')
    const invitationId = await staffInvitationFor(email, 2 * HOUR_MS)
    const before = await invitationState(invitationId)

    await requestSignInLink({ email, app: 'apex' })()

    const after = await invitationState(invitationId)
    expect(await linkRowCount(email)).toBe(0)
    expect(after.tokenHash).not.toBe(before.tokenHash)
    expect(after.lastSentAt).not.toBe(before.lastSentAt)
    expect(new Date(after.lastSentAt ?? 0).getTime()).toBeGreaterThan(
      new Date(before.lastSentAt ?? 0).getTime()
    )
    // A request from anyone must not lengthen a staff invitation's life.
    expect(after.expiresAt).toBe(before.expiresAt)
    expect(await messageCount(email, 'tenant_invitation')).toBe(1)
    expect(await messageCount(email, 'sign_in_link')).toBe(0)
    expect(await resentAudit(invitationId)).toEqual({
      actorKind: 'system',
      access: 'system',
      metadata: { role: 'viewer', emailDomain: 'example.test', trigger: 'sign_in_request' },
    })
  })

  it('states the days the resent invitation actually has left', async () => {
    const email = uniqueEmail('days-left')
    // 30 hours left: rounding up would promise 2 days, past the real expiry.
    await staffInvitationFor(email, 2 * HOUR_MS, 30 * HOUR_MS)

    await requestSignInLink({ email, app: 'apex' })()

    const [message] = await sql<{ expiresInDays: string }[]>`
      select variables->>'expiresInDays' as "expiresInDays" from email_messages
      where recipient = ${email} and template_key = 'tenant_invitation'
    `
    expect(message?.expiresInDays).toBe('1')
  })

  it('answers one 202 body for staff, a staff invitee, a customer and an unknown address', async () => {
    const { user: staff } = await createTrackedStaff('viewer', { email: uniqueEmail('body-staff') })
    const invitee = uniqueEmail('body-invitee')
    await staffInvitationFor(invitee, 2 * HOUR_MS)
    const customer = await createTrackedUser({ email: uniqueEmail('body-customer') })
    const unknown = uniqueEmail('body-unknown')

    const responses = await Promise.all(
      [staff.email, invitee, customer.email, unknown].map((email) =>
        postRequest({ email, app: 'apex' })
      )
    )

    for (const response of responses) {
      expect(response.status).toBe(202)
      expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
      expect(response.text).toBe(responses[0]?.text)
    }
    // The follow-ups run after the reply; wait for the two that mail before cleanup.
    await waitUntil(
      async () => (await messageCount(staff.email, 'sign_in_link')) === 1 || undefined,
      {
        message: 'the link mailed to staff',
      }
    )
    await waitUntil(
      async () => (await messageCount(invitee, 'tenant_invitation')) === 1 || undefined,
      {
        message: 'the invitation mailed again to the invitee',
      }
    )
  })

  it('sends nothing when the pending staff invitation is inside its resend cooldown', async () => {
    const email = uniqueEmail('cooldown')
    const invitationId = await staffInvitationFor(email, 1000)
    const before = await invitationState(invitationId)

    await requestSignInLink({ email, app: 'apex' })()

    expect(await invitationState(invitationId)).toEqual(before)
    expect(await messageCount(email, 'tenant_invitation')).toBe(0)
    expect(await linkRowCount(email)).toBe(0)
    expect(await resentAudit(invitationId)).toBeUndefined()
    const response = await postRequest({ email, app: 'apex' })
    expect(response.status).toBe(202)
    expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
  })

  it('resends nothing to a pending invitation in a customer tenant', async () => {
    const email = uniqueEmail('customer-invitee')
    const owner: User = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `apex-link-${randomUUID()}`,
      ownerId: owner.id,
    })
    const rawToken = randomBytes(32).toString('base64url')
    const created = await db.transaction((tx) =>
      invitationRepository.createPending(
        {
          tenantId: tenant.id,
          email,
          role: 'editor',
          tokenHash: hashToken(rawToken),
          invitedBy: owner.id,
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
        tx
      )
    )
    await sql`update tenant_invitations set last_sent_at = now() - interval '2 hours' where id = ${created.id}`
    const before = await invitationState(created.id)

    try {
      await requestSignInLink({ email, app: 'apex' })()

      expect(await invitationState(created.id)).toEqual(before)
      expect(await messageCount(email, 'tenant_invitation')).toBe(0)
    } finally {
      await sql`delete from tenant_invitations where id = ${created.id}`
      await sql`delete from tenants where id = ${tenant.id}`
    }
  })
})

describe('POST /auth/link/verify on Apex', () => {
  it('never creates an account from an apex link', async () => {
    const email = uniqueEmail('apex-new')
    const token = await issueTestLink(email, 'apex')

    const response = await postVerify({ token })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: LINK_INVALID_CODE })
    const users = await sql`select id from users where lower(email) = ${email}`
    expect(users).toHaveLength(0)
  })

  it('decides apex eligibility from the token, not the request', async () => {
    const { user: staff } = await createTrackedStaff('viewer', { email: uniqueEmail('staff-web') })
    const customer = await createTrackedUser({ email: uniqueEmail('customer-apex') })

    const webToken = await issueTestLink(staff.email, 'web')
    const staffResponse = await postVerify({ token: webToken, app: 'apex' })
    expect(staffResponse.status).toBe(200)
    expect((staffResponse.body as { data: { user: { id: string } } }).data.user.id).toBe(staff.id)

    const apexToken = await issueTestLink(customer.email, 'apex')
    const customerResponse = await postVerify({ token: apexToken, app: 'web' })
    expect(customerResponse.status).toBe(400)
    expect(customerResponse.body).toMatchObject({ code: LINK_INVALID_CODE })
    const [refresh] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${customer.id} and purpose = 'refresh'
    `
    expect(refresh?.count).toBe(0)
  })

  it('refuses an apex link for someone demoted since it was sent', async () => {
    const { user } = await createTrackedStaff('admin', { email: uniqueEmail('demoted') })
    const token = await issueTestLink(user.email, 'apex')
    const platform = await platformTenant()
    await sql`delete from user_memberships where user_id = ${user.id} and tenant_id = ${platform.id}`

    const response = await postVerify({ token })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: LINK_INVALID_CODE })
    const [refresh] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${user.id} and purpose = 'refresh'
    `
    expect(refresh?.count).toBe(0)
  })

  it('signs a staff member in to Apex with their platform role', async () => {
    const { user } = await createTrackedStaff('admin', { email: uniqueEmail('staff-apex') })
    const token = await issueTestLink(user.email, 'apex')

    const response = await postVerify({ token })

    expect(response.status).toBe(200)
    expect(
      (response.body as { data: { user: { id: string; platformRole: string } } }).data.user
    ).toMatchObject({ id: user.id, platformRole: 'admin' })
  })
})
