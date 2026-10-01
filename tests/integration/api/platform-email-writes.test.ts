/**
 * @file POST /platform/emails/:id/resend and
 * POST /platform/email-suppressions/:id/lift. A resend runs the SP2 action
 * that sent the mail, so that action's 403/404/409s pass straight through
 * and its audit entry is written beside `email.resent`. Mail is asserted on
 * the queue and in `email_messages`, never delivered.
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
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken, signAccessToken } from '@/services/session.service'
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

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
}

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

function post(token: string, path: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending
  return response.status
}

function resend(token: string, message: EmailMessage, body?: object): Promise<Response> {
  return post(token, `/emails/${message.id}/resend`, body)
}

/**
 * A staff member with a token minted at a sign-in `authenticatedAt` ago
 * (fresh by default); `createTrackedStaff`'s own token carries no
 * `auth_time`, so it is always stale.
 * @param role - The platform role.
 * @param authenticatedAt - When the session signed in.
 * @returns The user and the token.
 */
async function staffSignedIn(
  role: MembershipRole,
  authenticatedAt: Date = new Date()
): Promise<{ user: User; token: string }> {
  const { user } = await createTrackedStaff(role)
  return { user, token: signAccessToken(user, randomUUID(), authenticatedAt) }
}

async function auditRows(targetId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, tenant_id, target_type, access, metadata from audit_logs
    where target_id = ${targetId} order by occurred_at, id
  `
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await auditRows(targetId)
  return rows.map((row) => row.action)
}

async function resentRows(originalId: string): Promise<{ id: string; template_key: string }[]> {
  return sql<{ id: string; template_key: string }[]>`
    select id, template_key from email_messages where resent_from_id = ${originalId}
  `
}

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
 * A pending invitation in `tenant` and the tracked message that mailed it.
 * @param tenant - The tenant.
 * @param role - The role it offers.
 * @returns The invitation id and the message.
 */
async function invitationMessage(
  tenant: Tenant,
  role: MembershipRole = 'editor'
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
    templateKey: 'tenant_invitation',
    tenantId: tenant.id,
    invitationId: invitation.id,
    linkApp: tenant.isPlatform ? 'apex' : 'web',
    variables: { tenantName: tenant.name, role, expiresInDays: '7', appName: 'Acme' },
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
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /platform/emails/:id/resend: password-setup messages', () => {
  it('resends an account_setup mail as a fresh set-password link and audits both entries', async () => {
    const { user: actor, token } = await createTrackedStaff('admin')
    const user = await createTrackedUser({ hasPassword: false })
    const original = await createTrackedMessage({ recipient: user.email, userId: user.id })

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
    expect(created?.template_key).toBe('account_setup')

    const platform = await platformTenant()
    expect(await auditRows(original.id)).toEqual([
      {
        action: 'email.resent',
        tenant_id: platform.id,
        target_type: 'email_message',
        access: 'platform',
        metadata: { reason: REASON, emailDomain: 'example.test', templateKey: 'account_setup' },
      },
    ])
    expect(await auditActions(user.id)).toEqual(['user.password_setup_sent'])
    const [resentEntry] = await sql<{ actor_user_id: string }[]>`
      select actor_user_id from audit_logs where action = 'email.resent' and target_id = ${original.id}`
    expect(resentEntry?.actor_user_id).toBe(actor.id)
  })

  it('sends password_reset for a user who has a password now, whatever the original was', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser({ hasPassword: true })
    const original = await createTrackedMessage({ recipient: user.email, userId: user.id })

    const response = await resend(token, original)

    expect(response.status).toBe(202)
    const job = await waitForJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === user.id && data.email?.templateKey === 'password_reset'
    )
    expect(job.data.emailContext?.resentFromId).toBe(original.id)
  })

  it('passes the 403 through when the target outranks the actor, and writes no email.resent', async () => {
    const { token } = await createTrackedStaff('admin')
    const owner = await createTrackedUser()
    await makeStaff(owner.id, 'owner')
    const original = await createTrackedMessage({ recipient: owner.email, userId: owner.id })

    const response = await resend(token, original)

    expect(response.status).toBe(403)
    expect((response.body as ApiEnvelope<unknown>).message).toBe(
      'Insufficient permissions to act on this staff member'
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
      'This account is deactivated; reactivate it first'
    )
    expect((deactivated.body as ApiEnvelope<unknown>).code).toBeUndefined()
  })
})

describe('POST /platform/emails/:id/resend: verification messages', () => {
  it('resends through resend-verification, carrying resentFromId to the notification job', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser({ hasPassword: true, verified: false })
    const original = await createTrackedMessage({
      recipient: user.email,
      userId: user.id,
      templateKey: 'email_verification',
    })

    const response = await resend(token, original)

    expect(response.status).toBe(202)
    expect((response.body as ApiEnvelope<unknown>).data).toEqual({ emailSent: true })
    const job = await waitForJob<NotificationJobData>(
      getNotificationQueue(),
      (data) => data.userId === user.id && data.type === 'verify_email'
    )
    expect(job.data.emailContext?.resentFromId).toBe(original.id)
    expect(await auditActions(user.id)).toEqual(['user.verification_resent'])
    const resentEntries = await auditRows(original.id)
    expect(resentEntries.map((row) => row.metadata)).toEqual([
      { reason: REASON, emailDomain: 'example.test', templateKey: 'email_verification' },
    ])
  })

  it('passes the code-less 409 through for an address verified since', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser({ hasPassword: true, verified: true })
    const original = await createTrackedMessage({
      recipient: user.email,
      userId: user.id,
      templateKey: 'email_verification',
    })

    const response = await resend(token, original)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ message: 'Email address already verified' })
    expect((response.body as ApiEnvelope<unknown>).code).toBeUndefined()
    expect(await auditRows(original.id)).toEqual([])
  })
})

describe('POST /platform/emails/:id/resend: invitations', () => {
  it('resends a customer-tenant invitation with a stale sign-in: 202 with no emailSent', async () => {
    const { token } = await createTrackedStaff('admin')
    const tenant = await customerTenant()
    const { invitationId, message } = await invitationMessage(tenant)

    const response = await resend(token, message)

    expect(response.status).toBe(202)
    expect((response.body as ApiEnvelope<Record<string, unknown>>).data).toEqual({})
    const invitationAudit = await auditRows(invitationId)
    expect(invitationAudit.map((row) => [row.action, row.tenant_id, row.access])).toEqual([
      ['invitation.resent', tenant.id, 'platform'],
    ])
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
      'Insufficient permissions to grant this role'
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

describe('POST /platform/emails/:id/resend: refusals before delegating', () => {
  it.each(['password_changed', 'registration_attempt'])(
    'answers 409 not_resendable for the security notice %s',
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
      expect((response.body as ApiEnvelope<unknown>).code).toBe('not_resendable')
      expect(await auditRows(original.id)).toEqual([])
    }
  )

  it('answers 409 not_resendable for legacy rows without the ids their action needs', async () => {
    const { token } = await createTrackedStaff('admin')
    const setup = await createTrackedMessage({ templateKey: 'account_setup', variables: {} })
    const invitation = await createTrackedMessage({ templateKey: 'tenant_invitation' })

    for (const message of [setup, invitation]) {
      const response = await resend(token, message)
      expect(response.status).toBe(409)
      expect((response.body as ApiEnvelope<unknown>).code).toBe('not_resendable')
    }
  })

  it('answers 409 template_unavailable for a template not in the registry', async () => {
    const { token } = await createTrackedStaff('admin')
    const original = await createTrackedMessage({ templateKey: 'retired_template' })

    const response = await resend(token, original)

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).code).toBe('template_unavailable')
  })

  it('answers 409 recipient_suppressed, and resends once the suppression is lifted', async () => {
    const { token } = await staffSignedIn('admin')
    const user = await createTrackedUser()
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
