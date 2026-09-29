/**
 * @file Purge: an owner permanently removes a soft-deleted user or an
 * archived tenant. The user's entries in the audit log survive with the
 * actor erased; the tenant's own entries go with it; the purge itself is
 * recorded in the platform tenant. Each purge re-checks its actor inside
 * its transaction.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import {
  purgeTenant as purgeTenantAs,
  purgeUser as purgeUserAs,
} from '@/services/platform-purge.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  staleAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []
const mailedAddresses: string[] = []
const REASON = 'Erasure request, ticket 9001'

afterEach(async () => {
  await truncateAuditLogs()
  if (mailedAddresses.length > 0) {
    const lowered = mailedAddresses.map((address) => address.toLowerCase())
    await sql`delete from email_logs where lower(recipient) = any(${lowered})`
    // Invitations in the platform tenant outlive the per-test tenants' cascade.
    await sql`delete from tenant_invitations where lower(email) = any(${lowered})`
  }
  mailedAddresses.length = 0
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * Purge a user.
 * @param token - The caller's bearer token.
 * @param userId - The user.
 * @param body - The request body.
 * @returns The response.
 */
function purgeUser(token: string, userId: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/users/${userId}/purge`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

/**
 * Purge a tenant.
 * @param token - The caller's bearer token.
 * @param tenantId - The tenant.
 * @param body - The request body.
 * @returns The response.
 */
function purgeTenant(token: string, tenantId: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/purge`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

/**
 * A soft-deleted user who once acted in a tenant and was mailed.
 * @returns The user's id and email, the tenant they acted in, the id of that audit entry, and of an invitation they sent.
 */
async function deletedUserWithHistory(): Promise<{
  id: string
  email: string
  tenantId: string
  auditId: string
  sentInvitationId: string
}> {
  const user = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'History Co',
    slug: `hist-${randomUUID()}`,
    ownerId: user.id,
  })
  tenantIds.push(tenant.id)
  const [entry] = await sql<{ id: string }[]>`
    insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, ip, user_agent)
    values ('user', ${user.id}, 'member', ${tenant.id}, 'tenant.updated', 'tenant', ${tenant.id}, '203.0.113.9', 'Mozilla/5.0')
    returning id
  `
  await sql`
    insert into email_logs (recipient, template_key, status)
    values (${user.email}, 'password_reset', 'sent')
  `
  // An invitation they sent to someone else, which the purge unlinks but keeps.
  const inviteeEmail = `invitee-${randomUUID()}@example.test`
  const [sent] = await sql<{ id: string }[]>`
    insert into tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${tenant.id}, ${inviteeEmail}, 'viewer', ${randomUUID().replaceAll('-', '')}, ${user.id}, now() + interval '1 day')
    returning id`
  await sql`update users set deleted_at = now() where id = ${user.id}`
  if (!entry || !sent) throw new Error('fixture insert returned no row')
  return {
    id: user.id,
    email: user.email,
    tenantId: tenant.id,
    auditId: entry.id,
    sentInvitationId: sent.id,
  }
}

describe('POST /api/v1/platform/users/:id/purge', () => {
  it('removes the user and their mail log, keeps their audit entries with the actor erased, and records the purge', async () => {
    const { user: owner, token } = await createTrackedStaff('owner')
    const gone = await deletedUserWithHistory()
    const platform = await platformTenant()
    // An invitation addressed to them before the deletion holds the address too.
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at, created_at)
      values (${platform.id}, ${gone.email.toUpperCase()}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day', now() - interval '1 hour')`

    const response = await purgeUser(token, gone.id)

    expect(response.status).toBe(200)
    expect(
      await sql`select 1 from tenant_invitations where lower(email) = lower(${gone.email})`
    ).toHaveLength(0)
    expect(await sql`select 1 from users where id = ${gone.id}`).toHaveLength(0)
    const [sent] =
      await sql`select invited_by from tenant_invitations where id = ${gone.sentInvitationId}`
    // eslint-disable-next-line unicorn/no-null -- the foreign key sets it to SQL NULL
    expect(sent).toEqual({ invited_by: null })
    expect(await sql`select 1 from user_memberships where user_id = ${gone.id}`).toHaveLength(0)
    expect(
      await sql`select 1 from email_logs where lower(recipient) = lower(${gone.email})`
    ).toHaveLength(0)
    const [entry] = await sql`
      select actor_user_id is null and ip is null and user_agent is null as is_redacted, actor_kind, action
      from audit_logs where id = ${gone.auditId}`
    expect(entry).toEqual({ is_redacted: true, actor_kind: 'user', action: 'tenant.updated' })
    const [purged] = await sql`
      select tenant_id, actor_user_id, metadata from audit_logs
      where action = 'user.purged' and target_id = ${gone.id}`
    expect(purged).toEqual({
      tenant_id: platform.id,
      actor_user_id: owner.id,
      metadata: { reason: REASON, emailDomain: 'example.test' },
    })
  })

  it('touches only the purged user: other actors, other recipients and the target id stay', async () => {
    const { token } = await createTrackedStaff('owner')
    const gone = await deletedUserWithHistory()
    const bystander = await createTrackedUser()
    const second = await tenantRepository.create({
      name: 'Second Co',
      slug: `second-${randomUUID()}`,
      ownerId: bystander.id,
    })
    tenantIds.push(second.id)
    // In a second tenant the purged user is both the actor and the target.
    const [selfEntry] = await sql<{ id: string }[]>`
      insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, ip, user_agent)
      values ('user', ${gone.id}, 'member', ${second.id}, 'user.updated', 'user', ${gone.id}, '203.0.113.10', 'Mozilla/5.0')
      returning id`
    const [otherEntry] = await sql<{ id: string }[]>`
      insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, ip, user_agent)
      values ('user', ${bystander.id}, 'member', ${second.id}, 'user.updated', 'user', ${gone.id}, '198.51.100.4', 'curl/8')
      returning id`
    mailedAddresses.push(bystander.email)
    await sql`
      insert into email_logs (recipient, template_key, status)
      values (${bystander.email}, 'password_reset', 'sent')`
    if (!selfEntry || !otherEntry) throw new Error('fixture insert returned no row')

    const response = await purgeUser(token, gone.id)

    expect(response.status).toBe(200)
    // Both entries they acted in, one per tenant, lose the actor; the target stays.
    const redacted = await sql`
      select tenant_id, actor_user_id is null and ip is null and user_agent is null as is_redacted,
        actor_kind, target_type, target_id
      from audit_logs where id = any(${[gone.auditId, selfEntry.id]})
      order by tenant_id = ${second.id}`
    expect(redacted).toEqual([
      {
        tenant_id: gone.tenantId,
        is_redacted: true,
        actor_kind: 'user',
        target_type: 'tenant',
        target_id: gone.tenantId,
      },
      {
        tenant_id: second.id,
        is_redacted: true,
        actor_kind: 'user',
        target_type: 'user',
        target_id: gone.id,
      },
    ])
    const [other] = await sql`
      select actor_user_id, ip, user_agent, target_id from audit_logs where id = ${otherEntry.id}`
    expect(other).toEqual({
      actor_user_id: bystander.id,
      ip: '198.51.100.4',
      user_agent: 'curl/8',
      target_id: gone.id,
    })
    expect(await sql`select 1 from email_logs where recipient = ${bystander.email}`).toHaveLength(1)
  })

  it('leaves every address-keyed row alone when a live account now holds the address', async () => {
    const { token } = await createTrackedStaff('owner')
    const gone = await deletedUserWithHistory()
    const platform = await platformTenant()
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at, created_at)
      values (${platform.id}, ${gone.email}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day', now() - interval '1 hour')`
    mailedAddresses.push(gone.email)
    // The address was reused: the successor's own mail and invitation.
    const successor = await createTrackedUser({ email: gone.email.toUpperCase() })
    mailedAddresses.push(successor.email)
    await sql`
      insert into email_logs (recipient, template_key, status)
      values (${successor.email}, 'email_verification', 'sent')`
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${gone.tenantId}, ${successor.email}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day')`

    const response = await purgeUser(token, gone.id)

    expect(response.status).toBe(200)
    expect(await sql`select 1 from users where id = ${gone.id}`).toHaveLength(0)
    expect(await sql`select 1 from users where id = ${successor.id}`).toHaveLength(1)
    // The purged user's rows before the deletion stay too: the database can't tell them from the successor's.
    expect(
      await sql`select template_key from email_logs where lower(recipient) = lower(${gone.email}) order by template_key`
    ).toEqual([{ template_key: 'email_verification' }, { template_key: 'password_reset' }])
    expect(
      await sql`select tenant_id from tenant_invitations where lower(email) = lower(${gone.email}) order by created_at`
    ).toEqual([{ tenant_id: platform.id }, { tenant_id: gone.tenantId }])
  })

  it('without a live holder, deletes the rows up to the deletion and keeps the ones after it', async () => {
    const { token } = await createTrackedStaff('owner')
    const gone = await deletedUserWithHistory()
    await sql`update users set deleted_at = now() - interval '1 hour' where id = ${gone.id}`
    await sql`update email_logs set created_at = now() - interval '2 hours' where recipient = ${gone.email}`
    const platform = await platformTenant()
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at, created_at)
      values (${platform.id}, ${gone.email}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day', now() - interval '2 hours')`
    // Written after the deletion: the address may since have been claimed by someone else.
    mailedAddresses.push(gone.email)
    await sql`
      insert into email_logs (recipient, template_key, status)
      values (${gone.email}, 'email_verification', 'sent')`
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${gone.tenantId}, ${gone.email}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day')`

    const response = await purgeUser(token, gone.id)

    expect(response.status).toBe(200)
    expect(
      await sql`select template_key from email_logs where lower(recipient) = lower(${gone.email})`
    ).toEqual([{ template_key: 'email_verification' }])
    expect(
      await sql`select tenant_id from tenant_invitations where lower(email) = lower(${gone.email})`
    ).toEqual([{ tenant_id: gone.tenantId }])
  })

  it('answers 409 for a user who is not soft-deleted', async () => {
    const { token } = await createTrackedStaff('owner')
    const live = await createTrackedUser()

    const response = await purgeUser(token, live.id)

    expect(response.status).toBe(409)
    expect((response.body as { message: string }).message).toBe(
      'Delete the user before purging them'
    )
  })

  it('is owner-only, needs a reason and a recent sign-in, and 404s an unknown id', async () => {
    const admin = await createTrackedStaff('admin')
    const owner = await createTrackedStaff('owner')
    const gone = await deletedUserWithHistory()

    const response = await purgeUser(admin.token, gone.id)
    expect(response.status).toBe(404)
    const response2 = await purgeUser(owner.token, gone.id, {})
    expect(response2.status).toBe(400)
    const stale = await purgeUser(staleAuthTokenFor(owner.user), gone.id)
    expect(stale.status).toBe(401)
    expect((stale.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)
    const response3 = await purgeUser(owner.token, randomUUID())
    expect(response3.status).toBe(404)
  })
})

describe('POST /api/v1/platform/tenants/:id/purge', () => {
  it('removes an archived tenant with its members, invitations and audit entries, and records the purge', async () => {
    const { user: owner, token } = await createTrackedStaff('owner')
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Gone Co',
      slug: `gone-${randomUUID()}`,
      ownerId: member.id,
    })
    tenantIds.push(tenant.id)
    await sql`
      insert into audit_logs (actor_kind, access, tenant_id, action, target_type, target_id)
      values ('system', 'system', ${tenant.id}, 'tenant.updated', 'tenant', ${tenant.id})`
    const inviteeEmail = `invitee-${randomUUID()}@example.test`
    await sql`
      insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
      values (${tenant.id}, ${inviteeEmail}, 'viewer', ${randomUUID().replaceAll('-', '')}, now() + interval '1 day')`
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    // Another tenant's entries must survive the purge untouched.
    const neighbour = await tenantRepository.create({
      name: 'Neighbour Co',
      slug: `neighbour-${randomUUID()}`,
      ownerId: member.id,
    })
    tenantIds.push(neighbour.id)
    await sql`
      insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, ip, user_agent)
      values ('user', ${member.id}, 'member', ${neighbour.id}, 'tenant.updated', 'tenant', ${neighbour.id}, '198.51.100.5', 'curl/8')`
    const neighbourEntries =
      await sql`select * from audit_logs where tenant_id = ${neighbour.id} order by id`
    expect(neighbourEntries).toHaveLength(1)

    const response = await purgeTenant(token, tenant.id)

    expect(response.status).toBe(200)
    expect(await sql`select 1 from tenants where id = ${tenant.id}`).toHaveLength(0)
    expect(await sql`select 1 from user_memberships where tenant_id = ${tenant.id}`).toHaveLength(0)
    expect(await sql`select 1 from tenant_invitations where tenant_id = ${tenant.id}`).toHaveLength(
      0
    )
    expect(await sql`select 1 from audit_logs where tenant_id = ${tenant.id}`).toHaveLength(0)
    expect(
      await sql`select * from audit_logs where tenant_id = ${neighbour.id} order by id`
    ).toEqual(neighbourEntries)
    expect(await sql`select 1 from users where id = ${member.id}`).toHaveLength(1)
    const platform = await platformTenant()
    const [purged] = await sql`
      select tenant_id, actor_user_id, metadata from audit_logs
      where action = 'tenant.purged' and target_id = ${tenant.id}`
    expect(purged).toEqual({
      tenant_id: platform.id,
      actor_user_id: owner.id,
      metadata: { reason: REASON, name: 'Gone Co', slug: tenant.slug, memberCount: 1 },
    })
  })

  it('answers 409 for a tenant that is not archived, and for the platform tenant', async () => {
    const { token } = await createTrackedStaff('owner')
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Live Co',
      slug: `live-${randomUUID()}`,
      ownerId: member.id,
    })
    tenantIds.push(tenant.id)
    const platform = await platformTenant()

    const live = await purgeTenant(token, tenant.id)
    expect(live.status).toBe(409)
    expect((live.body as { message: string }).message).toBe('Archive the tenant before purging it')
    const response = await purgeTenant(token, platform.id)
    expect(response.status).toBe(409)
  })

  it('is owner-only and needs a recent sign-in', async () => {
    const admin = await createTrackedStaff('admin')
    const owner = await createTrackedStaff('owner')

    const response = await purgeTenant(admin.token, randomUUID())
    expect(response.status).toBe(404)
    const stale = await purgeTenant(staleAuthTokenFor(owner.user), randomUUID())
    expect(stale.status).toBe(401)
    expect((stale.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)
  })
})

describe('the purge actor re-check under lock', () => {
  it('answers 401 to an owner whose account was deactivated, and purges nothing', async () => {
    const { user: owner } = await createTrackedStaff('owner', { active: false })
    const gone = await deletedUserWithHistory()
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Kept Co',
      slug: `kept-${randomUUID()}`,
      ownerId: member.id,
    })
    tenantIds.push(tenant.id)
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    const refused = { statusCode: 401, message: 'Account no longer exists or is inactive' }

    await expect(purgeUserAs({ userId: owner.id }, gone.id, REASON)).rejects.toMatchObject(refused)
    await expect(purgeTenantAs({ userId: owner.id }, tenant.id, REASON)).rejects.toMatchObject(
      refused
    )

    expect(await sql`select 1 from users where id = ${gone.id}`).toHaveLength(1)
    expect(await sql`select 1 from tenants where id = ${tenant.id}`).toHaveLength(1)
  })
})
