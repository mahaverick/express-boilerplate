/**
 * @file POST /platform/emails/:id/resend and POST /platform/email-suppressions/:id/lift. A resend
 * runs the action that sent the mail, so that action's 403/404/409s pass straight through and its
 * audit entry is written beside `email.resent`. Mail is asserted on the queue and in
 * `email_messages`, never delivered.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { EmailMessage } from '@/database/models/email-message.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { emailQueueFor, type EmailJobData } from '@/jobs/email.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken, signAccessToken } from '@/services/session.service'
import { SIGN_IN_LINK_TEMPLATE_KEY } from '@/templates/email/sign-in-link.template'
import { TENANT_INVITATION_TEMPLATE_KEY } from '@/templates/email/tenant-invitation.template'
import { WELCOME_TEMPLATE_KEY } from '@/templates/email/welcome.template'
import { RETIRED_EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedMessage,
  createTrackedSuppression,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitForJob } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

/**
 * The response envelope, narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
}

/**
 * An `audit_logs` row, narrowed to the columns these tests assert on.
 */
interface AuditRow {
  action: string
  tenant_id: string
  target_type: string
  access: string
  metadata: Record<string, unknown>
}

const app = createApp()
const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const createdTenantIds: string[] = []
const createdInvitationIds: string[] = []
const REASON = 'Customer asked on the phone'

/**
 * Every address a resend mailed a sign-in link to: those rows carry no user,
 * so `afterEach` deletes them by address.
 */
const usedEmails: string[] = []

/**
 * Staff write requests; with no body they carry the staff `reason` every write needs.
 */
function post(token: string, path: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

/**
 * Staff reads of the email views, used for the `canResend` hints and checks after a write.
 */
function get(token: string, path: string): Promise<Response> {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

/**
 * `canResend` for one message, from the detail and from the list row.
 */
async function resendHintsOf(
  token: string,
  message: EmailMessage
): Promise<{ detail: boolean; list: boolean | undefined }> {
  const detail = await get(token, `/emails/${message.id}`)
  const page = await request(app)
    .get('/api/v1/platform/emails')
    .query({ search: message.recipient })
    .set('Authorization', `Bearer ${token}`)
  const rows = (page.body as ApiEnvelope<{ items: { id: string; canResend: boolean }[] }>).data
    ?.items
  return {
    detail: (detail.body as ApiEnvelope<{ canResend: boolean }>).data?.canResend ?? false,
    list: rows?.find((row) => row.id === message.id)?.canResend,
  }
}

/**
 * The status of a request, for a case where only the status is under test.
 */
async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending
  return response.status
}

/**
 * Resends a tracked message as the actor under test; the body defaults to the staff `reason`.
 */
function resend(token: string, message: EmailMessage, body?: object): Promise<Response> {
  return post(token, `/emails/${message.id}/resend`, body)
}

/**
 * A staff member with a token minted at a sign-in at `authenticatedAt`
 * (now by default), so a test can pick a stale sign-in time;
 * `createTrackedStaff`'s own token is always recent.
 */
async function staffSignedIn(
  role: MembershipRole,
  authenticatedAt: Date = new Date()
): Promise<{ user: User; token: string }> {
  const { user } = await createTrackedStaff(role)
  return { user, token: signAccessToken(user, randomUUID(), authenticatedAt) }
}

/**
 * The audit entries that target `targetId`, oldest first.
 */
async function auditRows(targetId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, tenant_id, target_type, access, metadata from audit_logs
    where target_id = ${targetId} order by occurred_at, id
  `
}

/**
 * The actions of the audit entries that target `targetId`, oldest first.
 */
async function auditActions(targetId: string): Promise<string[]> {
  const rows = await auditRows(targetId)
  return rows.map((row) => row.action)
}

/**
 * The messages created by resending `originalId`.
 */
async function resentRows(originalId: string): Promise<{ id: string; template_key: string }[]> {
  return sql<{ id: string; template_key: string }[]>`
    select id, template_key from email_messages where resent_from_id = ${originalId}
  `
}

/**
 * A tracked customer tenant with a fresh owner, for staff to act on.
 */
async function customerTenant(): Promise<Tenant> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: `Resend Co ${randomUUID().slice(0, 6)}`,
    slug: `rs-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return tenant
}

/**
 * A pending invitation in `tenant` and the tracked message that mailed it:
 * the invitation itself, or the confirm link an invite click mailed.
 */
async function invitationMessage(
  tenant: Tenant,
  role: MembershipRole = 'editor',
  templateKey: 'tenant_invitation' | 'invitation_confirm' = 'tenant_invitation'
): Promise<{ invitationId: string; message: EmailMessage }> {
  const inviter = await createTrackedUser()
  const email = `invitee-${randomUUID()}@example.test`
  const invitation = await invitationRepository.createPending({
    tenantId: tenant.id,
    email,
    role,
    tokenHash: hashToken(randomBytes(32).toString('base64url')),
    invitedBy: inviter.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  createdInvitationIds.push(invitation.id)
  const message = await createTrackedMessage({
    recipient: email,
    templateKey,
    tenantId: tenant.id,
    invitationId: invitation.id,
    linkApp: tenant.isPlatform ? 'apex' : 'web',
    variables:
      templateKey === 'tenant_invitation'
        ? { tenantName: tenant.name, role, expiresInDays: '7', appName: 'Acme' }
        : {
            firstName: 'Grace',
            tenantName: tenant.name,
            role,
            expiresInMinutes: '15',
            appName: 'Acme',
          },
  })
  return { invitationId: invitation.id, message }
}

afterEach(async () => {
  await deleteTrackedEmailRows()
  await truncateAuditLogs()
  if (createdInvitationIds.length > 0) {
    // The platform tenant is never deleted, so its invitations go one by one.
    await sql`delete from tenant_invitations where id = any(${createdInvitationIds})`
    createdInvitationIds.length = 0
  }
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
  if (usedEmails.length === 0) return
  await sql`delete from user_tokens where email = any(${usedEmails})`
  usedEmails.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /platform/emails/:id/resend: sign-in link messages', () => {
  it.each([SIGN_IN_LINK_TEMPLATE_KEY, WELCOME_TEMPLATE_KEY])(
    'resends a sign_in_link or welcome message by sending a fresh sign-in link (%s)',
    async (templateKey) => {
      const { user: actor, token } = await createTrackedStaff('admin')
      const user = await createTrackedUser()
      usedEmails.push(user.email)
      const original = await createTrackedMessage({
        recipient: user.email,
        userId: user.id,
        templateKey,
      })

      const response = await resend(token, original)

      expect(response.status).toBe(202)
      expect((response.body as ApiEnvelope<unknown>).data).toEqual({ emailSent: true })
      const [created] = await waitUntil(
        async () => {
          const rows = await resentRows(original.id)
          return rows.length > 0 ? rows : undefined
        },
        { message: 'the resend creates a message linked back to the original' }
      )
      expect(created?.template_key).toBe(SIGN_IN_LINK_TEMPLATE_KEY)
      const job = await waitForJob<EmailJobData>(
        emailQueueFor(SIGN_IN_LINK_TEMPLATE_KEY),
        (data) => data.to === user.email && data.templateKey === SIGN_IN_LINK_TEMPLATE_KEY
      )
      expect((job.data.variables as { reason: string }).reason).toBe('staff')
      const [link] = await sql<{ count: number }[]>`
        select count(*)::int as count from user_tokens
        where email = ${user.email} and purpose = 'sign_in_link' and revoked_at is null`
      expect(link?.count).toBe(1)

      const platform = await platformTenant()
      expect(await auditRows(original.id)).toEqual([
        {
          action: 'email.resent',
          tenant_id: platform.id,
          target_type: 'email_message',
          access: 'platform',
          metadata: { reason: REASON, emailDomain: 'example.test', templateKey },
        },
      ])
      expect(await auditRows(user.id)).toMatchObject([
        { action: 'user.sign_in_link_sent', metadata: { app: 'web' } },
      ])
      const [resentEntry] = await sql<{ actor_user_id: string }[]>`
        select actor_user_id from audit_logs where action = 'email.resent' and target_id = ${original.id}`
      expect(resentEntry?.actor_user_id).toBe(actor.id)
    }
  )

  it('passes the 403 through when the target outranks the actor, and writes no email.resent', async () => {
    const { token } = await createTrackedStaff('admin')
    const owner = await createTrackedUser()
    await makeStaff(owner.id, 'owner')
    const original = await createTrackedMessage({ recipient: owner.email, userId: owner.id })

    const response = await resend(token, original)

    expect(response.status).toBe(403)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      "Your platform role can't act on this staff member. Ask a platform owner."
    )
    expect(await auditRows(original.id)).toEqual([])
  })

  it('passes the 404 through for a soft-deleted user and the 409 for a deactivated one', async () => {
    const { token } = await createTrackedStaff('admin')
    const gone = await createTrackedUser()
    await sql`update users set deleted_at = now() where id = ${gone.id}`
    const inactive = await createTrackedUser({ active: false })
    const toGone = await createTrackedMessage({ recipient: gone.email, userId: gone.id })
    const toInactive = await createTrackedMessage({
      recipient: inactive.email,
      userId: inactive.id,
    })

    const deleted = await resend(token, toGone)
    const deactivated = await resend(token, toInactive)

    expect(deleted.status).toBe(404)
    expect(deactivated.status).toBe(409)
    expect((deactivated.body as ApiEnvelope<unknown>).message).toBe(
      'This account is deactivated. Reactivate it, then try again.'
    )
    expect((deactivated.body as ApiEnvelope<unknown>).code).toBeUndefined()
  })
})

describe('POST /platform/emails/:id/resend: invitations', () => {
  it('asks for a recent sign-in on a customer-tenant invitation, and writes nothing', async () => {
    const tenant = await customerTenant()
    const { invitationId, message } = await invitationMessage(tenant)
    const { token: stale } = await staffSignedIn('admin', new Date(Date.now() - 11 * 60 * 1000))

    const refused = await resend(stale, message)

    expect(refused.status).toBe(401)
    expect((refused.body as ApiEnvelope<unknown>).code).toBe(REAUTH_REQUIRED_CODE)
    expect(await auditRows(invitationId)).toEqual([])
    expect(await auditActions(message.id)).toEqual([])
  })

  it('resends a customer-tenant invitation once fresh: 202 with no emailSent, the reason audited and never mailed', async () => {
    const { token } = await staffSignedIn('admin')
    const tenant = await customerTenant()
    const { invitationId, message } = await invitationMessage(tenant)

    const response = await resend(token, message)

    expect(response.status).toBe(202)
    expect((response.body as ApiEnvelope<Record<string, unknown>>).data).toEqual({})
    const invitationAudit = await auditRows(invitationId)
    expect(invitationAudit.map((row) => [row.action, row.tenant_id, row.access])).toEqual([
      ['invitation.resent', tenant.id, 'platform'],
    ])
    expect(invitationAudit[0]?.metadata).toMatchObject({ reason: REASON })
    expect(await auditActions(message.id)).toEqual(['email.resent'])
    await waitUntil(
      async () => {
        const rows = await resentRows(message.id)
        return rows.length > 0
      },
      {
        message: 'the invitation resend creates a message linked back to the original',
      }
    )
    // Neither the job nor the stored message carries the reason: it stays in the audit entry.
    const job = await waitForJob<EmailJobData>(
      emailQueueFor(TENANT_INVITATION_TEMPLATE_KEY),
      (data) => data.to === message.recipient && data.templateKey === TENANT_INVITATION_TEMPLATE_KEY
    )
    expect(JSON.stringify(job.data)).not.toContain(REASON)
    const messageRows = await sql<{ row: unknown }[]>`
      select to_jsonb(email_messages) as row from email_messages where resent_from_id = ${message.id}`
    expect(messageRows).toHaveLength(1)
    expect(JSON.stringify(messageRows[0]?.row)).not.toContain(REASON)
  })

  it('answers a resend of an invitation confirm mail by sending the invitation itself', async () => {
    const { token } = await staffSignedIn('admin')
    const tenant = await customerTenant()
    const { invitationId, message } = await invitationMessage(
      tenant,
      'editor',
      'invitation_confirm'
    )

    const response = await resend(token, message)

    expect(response.status).toBe(202)
    const invitationAudit = await auditRows(invitationId)
    expect(invitationAudit.map((row) => row.action)).toEqual(['invitation.resent'])
    const job = await waitForJob<EmailJobData>(
      emailQueueFor(TENANT_INVITATION_TEMPLATE_KEY),
      (data) => data.to === message.recipient && data.templateKey === TENANT_INVITATION_TEMPLATE_KEY
    )
    expect(job.data.templateKey).toBe(TENANT_INVITATION_TEMPLATE_KEY)
  })

  it('resends straight after the last mail, skipping the cooldown, and still spends the address budget', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    // The invitation is stamped as mailed now, well inside the cooldown.
    const { message } = await invitationMessage(tenant)

    const response = await resend(token, message)

    expect(response.status).toBe(202)
    const redis = await getRedis()
    const key = redisKey(
      'rl',
      'invitation-recipient',
      hashRateLimitIdentity(message.recipient.toLowerCase())
    )
    expect(await redis.get(key)).toBe('1')
    expect(await redis.get(`${key}:${tenant.id}`)).toBe('1')
  })

  it('asks for a recent sign-in on a platform-tenant invitation, and resends once fresh', async () => {
    const platform = await platformTenant()
    const { message } = await invitationMessage(platform, 'viewer')
    const { token: stale } = await staffSignedIn('admin', new Date(Date.now() - 11 * 60 * 1000))
    const { token: fresh } = await staffSignedIn('admin')

    const refused = await resend(stale, message)
    const accepted = await resend(fresh, message)

    expect(refused.status).toBe(401)
    expect((refused.body as ApiEnvelope<unknown>).code).toBe(REAUTH_REQUIRED_CODE)
    expect(accepted.status).toBe(202)
    expect(await auditActions(message.id)).toEqual(['email.resent'])
  })

  it('passes the 403 through when an admin resends an admin invitation', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { message } = await invitationMessage(tenant, 'admin')

    const response = await resend(token, message)

    expect(response.status).toBe(403)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      "Your role can't grant this role. Ask a workspace owner."
    )
  })

  it('passes 404 invitation_not_found through once the invitation is no longer pending', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { invitationId, message } = await invitationMessage(tenant)
    await sql`update tenant_invitations set revoked_at = now() where id = ${invitationId}`

    const response = await resend(token, message)

    expect(response.status).toBe(404)
    expect((response.body as ApiEnvelope<unknown>).code).toBe('invitation_not_found')
  })

  it('answers 404 Tenant not found for a suspended tenant, as the member route does', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { message } = await invitationMessage(tenant)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenant.id}`

    const response = await resend(token, message)

    expect(response.status).toBe(404)
    expect((response.body as ApiEnvelope<unknown>).message).toBe('Tenant not found')
  })
})

describe('canResend for invitation emails', () => {
  it('is true, in the detail and the list, for a pending invitation on an active tenant', async () => {
    const { token } = await createTrackedStaff('admin')
    const { message } = await invitationMessage(await customerTenant())

    expect(await resendHintsOf(token, message)).toEqual({ detail: true, list: true })
  })

  it.each([
    [
      'accepted',
      (id: string) => sql`update tenant_invitations set accepted_at = now() where id = ${id}`,
    ],
    [
      'revoked',
      (id: string) => sql`update tenant_invitations set revoked_at = now() where id = ${id}`,
    ],
  ])('is false, in the detail and the list, for a %s invitation', async (_state, change) => {
    const { token } = await createTrackedStaff('admin')
    const { invitationId, message } = await invitationMessage(await customerTenant())
    await change(invitationId)

    expect(await resendHintsOf(token, message)).toEqual({ detail: false, list: false })
  })

  it.each([
    [
      'suspended',
      (id: string) => sql`update tenants set lifecycle_state = 'suspended' where id = ${id}`,
    ],
    [
      'archived',
      (id: string) => sql`update tenants set lifecycle_state = 'archived' where id = ${id}`,
    ],
    ['soft-deleted', (id: string) => sql`update tenants set deleted_at = now() where id = ${id}`],
  ])('is false, in the detail and the list, for a %s tenant', async (_state, change) => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { message } = await invitationMessage(tenant)
    await change(tenant.id)

    expect(await resendHintsOf(token, message)).toEqual({ detail: false, list: false })
  })

  it('answers the same 404 Tenant not found for a soft-deleted tenant', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { message } = await invitationMessage(tenant)
    await sql`update tenants set deleted_at = now() where id = ${tenant.id}`

    const response = await resend(token, message)

    expect(response.status).toBe(404)
    expect((response.body as ApiEnvelope<unknown>).message).toBe('Tenant not found')
  })
})

describe('POST /platform/emails/:id/resend: refusals before delegating', () => {
  it.each(['onboarding_reminder', 'maintenance_mode_changed', 'step_up_link'])(
    'answers 409 not_resendable for %s, which has no resend action',
    async (templateKey) => {
      const { token } = await createTrackedStaff('owner')
      const user = await createTrackedUser()
      const original = await createTrackedMessage({
        recipient: user.email,
        userId: user.id,
        templateKey,
        senderClass: 'general',
      })

      const response = await resend(token, original)

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({
        code: 'not_resendable',
        message:
          'This kind of email is never resent. Send a new one from the action that sent it, such as a new onboarding reminder.',
      })
      expect(await auditRows(original.id)).toEqual([])
    }
  )

  it('answers 409 not_resendable for legacy rows without the ids their action needs', async () => {
    const { token } = await createTrackedStaff('admin')
    const setup = await createTrackedMessage({ templateKey: 'sign_in_link', variables: {} })
    const invitation = await createTrackedMessage({ templateKey: 'tenant_invitation' })

    for (const message of [setup, invitation]) {
      const response = await resend(token, message)
      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({
        code: 'not_resendable',
        message:
          "This email lacks the record its resend needs, so it can't be resent. Send a new invitation, or a sign-in link from the user's profile, instead.",
      })
    }
  })

  it('answers 409 template_unavailable for a template not in the registry', async () => {
    const { token } = await createTrackedStaff('admin')
    const original = await createTrackedMessage({ templateKey: 'retired_template' })

    const response = await resend(token, original)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      code: 'template_unavailable',
      message:
        "This email's template is retired, so it can't be resent. Send the user a new sign-in link from their profile instead.",
    })
  })

  it.each(RETIRED_EMAIL_TEMPLATE_KEYS)(
    'answers 409 template_unavailable for the retired %s',
    async (templateKey) => {
      const { token } = await createTrackedStaff('admin')
      const user = await createTrackedUser()
      const original = await createTrackedMessage({
        recipient: user.email,
        userId: user.id,
        templateKey,
      })

      const response = await resend(token, original)

      expect(response.status).toBe(409)
      expect((response.body as ApiEnvelope<unknown>).code).toBe('template_unavailable')
      expect(await auditRows(original.id)).toEqual([])
      expect(await auditRows(user.id)).toEqual([])
    }
  )

  it('answers 409 recipient_suppressed, and resends once the suppression is lifted', async () => {
    const { token } = await staffSignedIn('admin')
    const user = await createTrackedUser()
    usedEmails.push(user.email)
    const original = await createTrackedMessage({ recipient: user.email, userId: user.id })
    const suppression = await createTrackedSuppression(user.email)

    const refused = await resend(token, original)
    const lifted = await post(token, `/email-suppressions/${suppression.id}/lift`)
    const accepted = await resend(token, original)

    expect(refused.status).toBe(409)
    expect((refused.body as ApiEnvelope<unknown>).code).toBe('recipient_suppressed')
    expect(lifted.status).toBe(200)
    expect(accepted.status).toBe(202)
  })

  it('answers 404 for an unknown or malformed id, and 400 without a reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const original = await createTrackedMessage()

    const unknownId = randomUUID()
    expect(await statusOf(post(token, `/emails/${unknownId}/resend`))).toBe(404)
    expect(await statusOf(post(token, '/emails/not-a-uuid/resend'))).toBe(404)
    expect(await statusOf(resend(token, original, {}))).toBe(400)
    expect(await statusOf(resend(token, original, { reason: REASON, extra: true }))).toBe(400)
  })

  it("answers a viewer with the app's own 404", async () => {
    const { token } = await createTrackedStaff('viewer')
    const original = await createTrackedMessage()

    const response = await resend(token, original)

    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })
})

describe('POST /platform/email-suppressions/:id/lift', () => {
  it('lifts an active suppression, records who and why, and audits it without the address', async () => {
    const { user: actor, token } = await createTrackedStaff('admin')
    await sql`update users set first_name = 'Grace' where id = ${actor.id}`
    const address = `lift-${randomUUID()}@Example.test`
    const suppression = await createTrackedSuppression(address)

    const response = await post(token, `/email-suppressions/${suppression.id}/lift`)

    expect(response.status).toBe(200)
    expect((response.body as ApiEnvelope<unknown>).data).toMatchObject({
      id: suppression.id,
      address: address.toLowerCase(),
      liftedBy: { id: actor.id, name: 'Grace' },
      liftReason: REASON,
      liftedAt: expect.any(String) as unknown,
    })
    const platform = await platformTenant()
    const rows = await auditRows(suppression.id)
    expect(rows).toEqual([
      {
        action: 'email.suppression_lifted',
        tenant_id: platform.id,
        target_type: 'email_suppression',
        access: 'platform',
        metadata: { reason: REASON, emailDomain: 'example.test' },
      },
    ])
    expect(JSON.stringify(rows)).not.toContain(address.toLowerCase())
  })

  it('answers 409 already_lifted for a second lift, 404 for an unknown id, 400 without a reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const suppression = await createTrackedSuppression(`lift-${randomUUID()}@example.test`, {
      isLifted: true,
    })

    const again = await post(token, `/email-suppressions/${suppression.id}/lift`)

    expect(again.status).toBe(409)
    expect((again.body as ApiEnvelope<unknown>).code).toBe('already_lifted')
    const unknownId = randomUUID()
    expect(await statusOf(post(token, `/email-suppressions/${unknownId}/lift`))).toBe(404)
    expect(await statusOf(post(token, `/email-suppressions/${suppression.id}/lift`, {}))).toBe(400)
  })

  it("answers a viewer with the app's own 404", async () => {
    const { token } = await createTrackedStaff('viewer')
    const suppression = await createTrackedSuppression(`lift-${randomUUID()}@example.test`)

    expect(await statusOf(post(token, `/email-suppressions/${suppression.id}/lift`))).toBe(404)
  })
})
