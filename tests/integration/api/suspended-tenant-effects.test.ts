/**
 * @file What a suspension freezes beyond the tenant routes: its invitations
 * cannot be previewed or accepted until it is reactivated. And what a member
 * sees of it afterwards: the audit entries, without the staff member's reason.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { waitForInvitationEmail } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A tenant owned by a fresh user, with an invitation to a second fresh user.
 * @returns The tenant, the owner's token, the invitee and the raw invitation token.
 */
async function tenantWithInvitation(): Promise<{
  tenantId: string
  slug: string
  ownerToken: string
  inviteeToken: string
  rawToken: string
}> {
  const owner = await createTrackedUser()
  const invitee = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Frozen Co',
    slug: `frozen-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  const ownerToken = tokenFor(owner)
  const invited = await request(app)
    .post(`/api/v1/tenants/${tenant.slug}/invitations`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: invitee.email, role: 'viewer' })
  expect(invited.status).toBe(202)
  const mail = await waitForInvitationEmail(invitee.email)
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    ownerToken,
    inviteeToken: tokenFor(invitee),
    rawToken: mail.token,
  }
}

/**
 * Move a tenant through a staff lifecycle action.
 * @param token - A staff admin's recently authenticated token.
 * @param tenantId - The tenant.
 * @param verb - The action.
 * @returns Resolves once it answered 200.
 */
async function lifecycle(
  token: string,
  tenantId: string,
  verb: 'suspend' | 'reactivate'
): Promise<void> {
  const response = await request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/${verb}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: `Staff note: ${verb}` })
  expect(response.status).toBe(200)
}

describe('a suspended tenant', () => {
  it('refuses its invitations until it is reactivated', async () => {
    const { token: staffToken } = await createTrackedStaff('admin')
    const { tenantId, inviteeToken, rawToken } = await tenantWithInvitation()
    await lifecycle(staffToken, tenantId, 'suspend')

    const preview = await request(app).post('/api/v1/invitations/preview').send({ token: rawToken })
    const accept = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${inviteeToken}`)
      .send({ token: rawToken })
    expect(preview.status).toBe(404)
    expect((preview.body as { code?: string }).code).toBe('invitation_invalid')
    expect(accept.status).toBe(404)
    expect((accept.body as { code?: string }).code).toBe('invitation_invalid')

    await lifecycle(staffToken, tenantId, 'reactivate')
    const later = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${inviteeToken}`)
      .send({ token: rawToken })
    expect(later.status).toBe(200)
  })

  it('shows its members the staff actions without the staff reason; staff still see it', async () => {
    const { token: staffToken } = await createTrackedStaff('admin')
    const { tenantId, slug, ownerToken } = await tenantWithInvitation()
    await lifecycle(staffToken, tenantId, 'suspend')
    await lifecycle(staffToken, tenantId, 'reactivate')

    const asMember = await request(app)
      .get(`/api/v1/tenants/${slug}/audit-log`)
      .set('Authorization', `Bearer ${ownerToken}`)
    const asStaff = await request(app)
      .get(`/api/v1/tenants/${slug}/audit-log`)
      .set('Authorization', `Bearer ${staffToken}`)

    type Entries = { data: { entries: { action: string; metadata: Record<string, unknown> }[] } }
    const memberSuspend = (asMember.body as Entries).data.entries.find(
      (entry) => entry.action === 'tenant.suspended'
    )
    const staffSuspend = (asStaff.body as Entries).data.entries.find(
      (entry) => entry.action === 'tenant.suspended'
    )
    expect(memberSuspend?.metadata).toEqual({})
    expect(staffSuspend?.metadata).toEqual({ reason: 'Staff note: suspend' })
  })
})
