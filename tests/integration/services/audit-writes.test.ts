// tests/integration/services/audit-writes.test.ts
//
// Every tenant, member and invitation mutation writes exactly one audit row
// inside its own transaction. The rollback cases let the real insert run and
// then fail the transaction: the row and the change must both be gone.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept, invite, resend, revoke } from '@/services/tenant-invitation.service'
import { changeRole, removeMember } from '@/services/tenant-membership.service'
import { createTenant, updateSettings, updateTenant } from '@/services/tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff } from '../../helpers/platform-staff'

const HOUR_MS = 60 * 60 * 1000
const ROLLBACK_MESSAGE = 'fail after the audit insert'

const auditLogRepository = new AuditLogRepository()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()
const realInsert = auditLogRepository.insert.bind(auditLogRepository)

interface AuditRow {
  actor_kind: string
  actor_user_id: string | null
  access: string
  tenant_id: string
  target_type: string | null
  target_id: string | null
  metadata: Record<string, unknown>
}

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

function uniqueEmail(): string {
  return `audit-writes-${randomUUID()}@example.test`
}

async function seedUser(options: { verified?: boolean } = {}): Promise<User> {
  const user = await userRepository.create({ email: uniqueEmail() })
  createdUserIds.push(user.id)
  if (options.verified === true) {
    await sql`update users set email_verified_at = now() where id = ${user.id}`
  }
  return user
}

async function seedTenant(): Promise<{ owner: User; tenant: Tenant }> {
  const owner = await seedUser()
  const tenant = await tenantRepository.create({
    name: 'Audit Co',
    slug: `audit-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { owner, tenant }
}

async function seedMember(tenant: Tenant, role: MembershipRole): Promise<User> {
  const user = await seedUser()
  await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
  return user
}

async function seedInvitation(
  tenant: Tenant,
  invitedBy: User,
  email: string
): Promise<{ rawToken: string; invitation: TenantInvitation }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'editor',
        tokenHash: hashToken(rawToken),
        invitedBy: invitedBy.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return { rawToken, invitation }
}

async function rowsFor(tenantId: string, action: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select actor_kind, actor_user_id, access, tenant_id, target_type, target_id, metadata
    from audit_logs where tenant_id = ${tenantId} and action = ${action}`
}

// The update tests backdate `updated_at` an hour first, so "left alone" is
// visible at any clock resolution. The raw client returns it as text.
async function backdateTenant(tenantId: string): Promise<string> {
  const [row] = await sql<{ updated_at: string }[]>`
    update tenants set updated_at = now() - interval '1 hour'
    where id = ${tenantId} returning updated_at`
  if (!row) throw new Error('tenant row missing')
  return row.updated_at
}

async function tenantUpdatedAt(tenantId: string): Promise<string | undefined> {
  const [row] = await sql<{ updated_at: string }[]>`
    select updated_at from tenants where id = ${tenantId}`
  return row?.updated_at
}

async function backdateSettings(tenantId: string): Promise<string> {
  const [row] = await sql<{ updated_at: string }[]>`
    update tenant_settings set updated_at = now() - interval '1 hour'
    where tenant_id = ${tenantId} returning updated_at`
  if (!row) throw new Error('settings row missing')
  return row.updated_at
}

async function settingsUpdatedAt(tenantId: string): Promise<string | undefined> {
  const [row] = await sql<{ updated_at: string }[]>`
    select updated_at from tenant_settings where tenant_id = ${tenantId}`
  return row?.updated_at
}

// The real insert runs, then the transaction fails: a row written through
// `tx` rolls back with the change; one written on the pool would survive.
async function expectRollback(run: () => Promise<unknown>): Promise<void> {
  await withMutatedMethod(
    AuditLogRepository.prototype,
    'insert',
    async (...insertArguments: Parameters<AuditLogRepository['insert']>) => {
      await realInsert(...insertArguments)
      throw new Error(ROLLBACK_MESSAGE)
    },
    async () => {
      await expect(run()).rejects.toThrow(ROLLBACK_MESSAGE)
    }
  )
}

describe('tenant.created', () => {
  it('writes one row naming the tenant, with the creator as a member actor', async () => {
    const actor = await seedUser()
    const slug = `audit-${randomUUID()}`

    const tenant = await createTenant({ userId: actor.id }, { name: 'Acme', slug })
    createdTenantIds.push(tenant.id)

    const rows = await rowsFor(tenant.id, 'tenant.created')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      actor_kind: 'user',
      actor_user_id: actor.id,
      access: 'member',
      tenant_id: tenant.id,
      target_type: 'tenant',
      target_id: tenant.id,
      metadata: { name: 'Acme', slug },
    })
  })

  it('leaves no tenant and no row when the transaction rolls back', async () => {
    const actor = await seedUser()
    const slug = `audit-${randomUUID()}`

    await expectRollback(() => createTenant({ userId: actor.id }, { name: 'Acme', slug }))

    expect(await sql`select id from tenants where slug = ${slug}`).toHaveLength(0)
    expect(await sql`select id from audit_logs where actor_user_id = ${actor.id}`).toHaveLength(0)
  })
})

describe('tenant.updated', () => {
  it('writes one row listing the changed field names, never their values', async () => {
    const { owner, tenant } = await seedTenant()

    await updateTenant({ userId: owner.id }, tenant.id, {
      website: 'https://acme.example',
      name: 'Renamed Co',
    })

    const rows = await rowsFor(tenant.id, 'tenant.updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'tenant',
      target_id: tenant.id,
      metadata: { changed: ['name', 'website'] },
    })
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Renamed')
  })

  it('writes nothing for a body with no recognised field', async () => {
    const { owner, tenant } = await seedTenant()

    await updateTenant({ userId: owner.id }, tenant.id, {})

    expect(await rowsFor(tenant.id, 'tenant.updated')).toHaveLength(0)
  })

  it('writes nothing and leaves updatedAt alone when every value matches the row', async () => {
    const { owner, tenant } = await seedTenant()
    const before = await backdateTenant(tenant.id)

    const result = await updateTenant({ userId: owner.id }, tenant.id, {
      name: 'Audit Co',
      // eslint-disable-next-line unicorn/no-null -- null is the stored value, submitted to prove it counts as unchanged
      description: null,
      // eslint-disable-next-line unicorn/no-null -- null is the stored value, submitted to prove it counts as unchanged
      logo: null,
      // eslint-disable-next-line unicorn/no-null -- null is the stored value, submitted to prove it counts as unchanged
      website: null,
    })

    expect(await rowsFor(tenant.id, 'tenant.updated')).toHaveLength(0)
    expect(await tenantUpdatedAt(tenant.id)).toEqual(before)
    expect(result.updatedAt.getTime()).toBe(new Date(before).getTime())
  })

  it('records only the fields whose value differs from the row', async () => {
    const { owner, tenant } = await seedTenant()

    await updateTenant({ userId: owner.id }, tenant.id, {
      name: 'Audit Co',
      // eslint-disable-next-line unicorn/no-null -- null is the stored value, submitted to prove it counts as unchanged
      description: null,
      website: 'https://acme.example',
    })

    const rows = await rowsFor(tenant.id, 'tenant.updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata).toEqual({ changed: ['website'] })
  })

  it('records platform access for a staff admin who is not a member', async () => {
    const { tenant } = await seedTenant()
    const staff = await seedUser()
    await makeStaff(staff.id, 'admin')

    await updateTenant({ userId: staff.id }, tenant.id, { name: 'Staff Edit' })

    const rows = await rowsFor(tenant.id, 'tenant.updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_user_id: staff.id, access: 'platform' })
  })

  it('leaves the old name and no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()

    await expectRollback(() =>
      updateTenant({ userId: owner.id }, tenant.id, { name: 'Rolled Back' })
    )

    const [row] = await sql<{ name: string }[]>`select name from tenants where id = ${tenant.id}`
    expect(row?.name).toBe('Audit Co')
    expect(await rowsFor(tenant.id, 'tenant.updated')).toHaveLength(0)
  })
})

describe('tenant.settings_updated', () => {
  it('writes one row against the settings target with the changed field names', async () => {
    const { owner, tenant } = await seedTenant()

    await updateSettings({ userId: owner.id }, tenant.id, {
      timezone: 'Europe/Paris',
      locale: 'fr',
    })

    const rows = await rowsFor(tenant.id, 'tenant.settings_updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      access: 'member',
      target_type: 'settings',
      target_id: tenant.id,
      metadata: { changed: ['locale', 'timezone'] },
    })
  })

  it('writes nothing and leaves updatedAt alone when every value matches the row', async () => {
    const { owner, tenant } = await seedTenant()
    await sql`
      update tenant_settings set metadata = ${JSON.stringify({ theme: { accent: 'blue' }, beta: true })}::jsonb
      where tenant_id = ${tenant.id}`
    const before = await backdateSettings(tenant.id)

    const result = await updateSettings({ userId: owner.id }, tenant.id, {
      timezone: 'UTC',
      locale: 'en',
      metadata: { beta: true, theme: { accent: 'blue' } },
    })

    expect(await rowsFor(tenant.id, 'tenant.settings_updated')).toHaveLength(0)
    expect(await settingsUpdatedAt(tenant.id)).toEqual(before)
    expect(result.updatedAt.getTime()).toBe(new Date(before).getTime())
  })

  it('records only the fields whose value differs from the row', async () => {
    const { owner, tenant } = await seedTenant()

    await updateSettings({ userId: owner.id }, tenant.id, {
      timezone: 'UTC',
      locale: 'fr',
      // eslint-disable-next-line unicorn/no-null -- null is the stored value, submitted to prove it counts as unchanged
      metadata: null,
    })

    const rows = await rowsFor(tenant.id, 'tenant.settings_updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata).toEqual({ changed: ['locale'] })
  })

  it('leaves the old settings and no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()

    await expectRollback(() =>
      updateSettings({ userId: owner.id }, tenant.id, { timezone: 'Europe/Paris' })
    )

    const [row] = await sql<
      { timezone: string }[]
    >`select timezone from tenant_settings where tenant_id = ${tenant.id}`
    expect(row?.timezone).toBe('UTC')
    expect(await rowsFor(tenant.id, 'tenant.settings_updated')).toHaveLength(0)
  })
})

describe('member.role_changed', () => {
  it('writes one row with the member, the old role and the new role', async () => {
    const { owner, tenant } = await seedTenant()
    const member = await seedMember(tenant, 'editor')
    const membership = await userMembershipRepository.findByUserAndTenant(member.id, tenant.id)

    await changeRole({ userId: owner.id }, tenant.id, member.id, 'viewer')

    const rows = await rowsFor(tenant.id, 'member.role_changed')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'membership',
      target_id: membership?.id,
      metadata: { userId: member.id, from: 'editor', to: 'viewer' },
    })
  })

  it('keeps the old role and writes no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()
    const member = await seedMember(tenant, 'editor')

    await expectRollback(() => changeRole({ userId: owner.id }, tenant.id, member.id, 'viewer'))

    const membership = await userMembershipRepository.findByUserAndTenant(member.id, tenant.id)
    expect(membership?.role).toBe('editor')
    expect(await rowsFor(tenant.id, 'member.role_changed')).toHaveLength(0)
  })
})

describe('member.removed', () => {
  it('writes one row with the removed role, self false', async () => {
    const { owner, tenant } = await seedTenant()
    const member = await seedMember(tenant, 'viewer')
    const membership = await userMembershipRepository.findByUserAndTenant(member.id, tenant.id)

    await removeMember({ userId: owner.id }, tenant.id, member.id)

    const rows = await rowsFor(tenant.id, 'member.removed')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'membership',
      target_id: membership?.id,
      metadata: { userId: member.id, role: 'viewer', self: false },
    })
  })

  it('records platform access for a staff admin who is not a member', async () => {
    const { tenant } = await seedTenant()
    const member = await seedMember(tenant, 'viewer')
    const staff = await seedUser()
    await makeStaff(staff.id, 'admin')

    await removeMember({ userId: staff.id }, tenant.id, member.id)

    const rows = await rowsFor(tenant.id, 'member.removed')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_user_id: staff.id, access: 'platform' })
  })

  it('marks self true when an owner removes themself', async () => {
    const { owner, tenant } = await seedTenant()
    await seedMember(tenant, 'owner')

    await removeMember({ userId: owner.id }, tenant.id, owner.id)

    const rows = await rowsFor(tenant.id, 'member.removed')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata).toEqual({ userId: owner.id, role: 'owner', self: true })
  })

  it('keeps the membership and writes no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()
    const member = await seedMember(tenant, 'viewer')

    await expectRollback(() => removeMember({ userId: owner.id }, tenant.id, member.id))

    expect(await userMembershipRepository.findByUserAndTenant(member.id, tenant.id)).toBeDefined()
    expect(await rowsFor(tenant.id, 'member.removed')).toHaveLength(0)
  })
})

describe('invitation.created', () => {
  it('writes one row with the role and the address domain only', async () => {
    const { owner, tenant } = await seedTenant()

    await invite({ userId: owner.id }, tenant.id, `Invitee-${randomUUID()}@Example.TEST`, 'editor')

    const [invitation] = await sql<
      { id: string }[]
    >`select id from tenant_invitations where tenant_id = ${tenant.id}`
    const rows = await rowsFor(tenant.id, 'invitation.created')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'invitation',
      target_id: invitation?.id,
    })
    expect(rows[0]?.metadata).toEqual({ role: 'editor', emailDomain: 'example.test' })
  })

  it('leaves no invitation and no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()

    await expectRollback(() => invite({ userId: owner.id }, tenant.id, uniqueEmail(), 'editor'))

    expect(
      await sql`select id from tenant_invitations where tenant_id = ${tenant.id}`
    ).toHaveLength(0)
    expect(await rowsFor(tenant.id, 'invitation.created')).toHaveLength(0)
  })
})

describe('invitation.resent', () => {
  it('writes one row with the role and the address domain only', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, uniqueEmail())

    await resend({ userId: owner.id }, tenant.id, invitation.id)

    const rows = await rowsFor(tenant.id, 'invitation.resent')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'invitation',
      target_id: invitation.id,
    })
    expect(rows[0]?.metadata).toEqual({ role: 'editor', emailDomain: 'example.test' })
  })

  it('keeps the old token and writes no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, uniqueEmail())

    await expectRollback(() => resend({ userId: owner.id }, tenant.id, invitation.id))

    const [row] = await sql<
      { token_hash: string }[]
    >`select token_hash from tenant_invitations where id = ${invitation.id}`
    expect(row?.token_hash).toBe(invitation.tokenHash)
    expect(await rowsFor(tenant.id, 'invitation.resent')).toHaveLength(0)
  })
})

// A stored address whose domain is no hostname (the invite validator now
// refuses these, but older rows may hold one) must not block a resend or a
// revoke: the audit entry records a null domain.
describe('an invitation whose stored domain is no hostname', () => {
  const badAddress = `invitee@${'a'.repeat(64)}.com`

  it('resends, recording a null domain', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, badAddress)

    await resend({ userId: owner.id }, tenant.id, invitation.id)

    const rows = await rowsFor(tenant.id, 'invitation.resent')
    expect(rows).toHaveLength(1)
    // eslint-disable-next-line unicorn/no-null -- the metadata stores JSON null
    expect(rows[0]?.metadata).toEqual({ role: 'editor', emailDomain: null })
  })

  it('revokes, recording a null domain', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, badAddress)

    await revoke({ userId: owner.id }, tenant.id, invitation.id)

    const rows = await rowsFor(tenant.id, 'invitation.revoked')
    expect(rows).toHaveLength(1)
    // eslint-disable-next-line unicorn/no-null -- the metadata stores JSON null
    expect(rows[0]?.metadata).toEqual({ role: 'editor', emailDomain: null })
  })
})

describe('invitation.revoked', () => {
  it('writes one row with the role and the address domain only', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, uniqueEmail())

    await revoke({ userId: owner.id }, tenant.id, invitation.id)

    const rows = await rowsFor(tenant.id, 'invitation.revoked')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_user_id: owner.id,
      access: 'member',
      target_type: 'invitation',
      target_id: invitation.id,
    })
    expect(rows[0]?.metadata).toEqual({ role: 'editor', emailDomain: 'example.test' })
  })

  it('leaves the invitation pending and writes no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()
    const { invitation } = await seedInvitation(tenant, owner, uniqueEmail())

    await expectRollback(() => revoke({ userId: owner.id }, tenant.id, invitation.id))

    const [row] = await sql<
      { revoked_at: Date | null }[]
    >`select revoked_at from tenant_invitations where id = ${invitation.id}`
    expect(row?.revoked_at).toBeNull()
    expect(await rowsFor(tenant.id, 'invitation.revoked')).toHaveLength(0)
  })
})

describe('invitation.accepted', () => {
  it('writes one row with the invitee as a member actor and the role now held', async () => {
    const { owner, tenant } = await seedTenant()
    const invitee = await seedUser({ verified: true })
    const { rawToken, invitation } = await seedInvitation(tenant, owner, invitee.email)

    await accept(rawToken, invitee.id)

    const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    const rows = await rowsFor(tenant.id, 'invitation.accepted')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      actor_kind: 'user',
      actor_user_id: invitee.id,
      access: 'member',
      tenant_id: tenant.id,
      target_type: 'membership',
      target_id: membership?.id,
      metadata: { role: 'editor', invitationId: invitation.id },
    })
  })

  it('writes no second row for an idempotent re-accept', async () => {
    const { owner, tenant } = await seedTenant()
    const invitee = await seedUser({ verified: true })
    const { rawToken } = await seedInvitation(tenant, owner, invitee.email)

    await accept(rawToken, invitee.id)
    await accept(rawToken, invitee.id)

    expect(await rowsFor(tenant.id, 'invitation.accepted')).toHaveLength(1)
  })

  it('leaves no membership, an unclaimed invitation and no row when the transaction rolls back', async () => {
    const { owner, tenant } = await seedTenant()
    const invitee = await seedUser({ verified: true })
    const { rawToken, invitation } = await seedInvitation(tenant, owner, invitee.email)

    await expectRollback(() => accept(rawToken, invitee.id))

    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    const [row] = await sql<
      { accepted_at: Date | null }[]
    >`select accepted_at from tenant_invitations where id = ${invitation.id}`
    expect(row?.accepted_at).toBeNull()
    expect(await rowsFor(tenant.id, 'invitation.accepted')).toHaveLength(0)
  })
})

describe('audit metadata', () => {
  it('holds no email address, raw token or token hash', async () => {
    const { owner, tenant } = await seedTenant()
    const invitee = await seedUser({ verified: true })
    await invite({ userId: owner.id }, tenant.id, uniqueEmail(), 'viewer')
    const cycled = await seedInvitation(tenant, owner, uniqueEmail())
    await resend({ userId: owner.id }, tenant.id, cycled.invitation.id)
    await revoke({ userId: owner.id }, tenant.id, cycled.invitation.id)
    const accepted = await seedInvitation(tenant, owner, invitee.email)
    await accept(accepted.rawToken, invitee.id)

    const rows = await sql<
      { action: string; metadata: Record<string, unknown> }[]
    >`select action, metadata from audit_logs where tenant_id = ${tenant.id}`
    expect(rows.map((row) => row.action).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'invitation.accepted',
      'invitation.created',
      'invitation.resent',
      'invitation.revoked',
    ])
    for (const row of rows) {
      const text = JSON.stringify(row.metadata)
      expect(text).not.toContain('@')
      expect(text).not.toContain(accepted.rawToken)
      expect(text).not.toContain(cycled.rawToken)
      expect(text).not.toMatch(/[\w-]{43}/)
      expect(text).not.toMatch(/[\da-f]{64}/)
    }
  })
})
