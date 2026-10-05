/**
 * @file flagContextForUser against the real per-worker Postgres: the user's
 * creation, platform role, membership role and the tenant's creation are
 * read, and an unknown user is a 404.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql } from '@/services/database.service'
import { flagContextForUser } from '@/services/flags/flag-context.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const createdTenantIds: string[] = []
// eslint-disable-next-line unicorn/no-null -- the function's contract uses null for "none"
const NONE = null

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

describe('flagContextForUser', () => {
  it('reads the traits of a member in a tenant', async () => {
    const owner = await createTrackedUser()
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Flags Co',
      slug: `flags-${randomUUID().slice(0, 8)}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    await userMembershipRepository.create({
      userId: member.id,
      tenantId: tenant.id,
      role: 'editor',
    })

    const context = await flagContextForUser(member.id, tenant.id, 'session-1')

    expect(context).toEqual({
      distinctId: member.id,
      groups: { tenant: tenant.id },
      personProps: {
        platform_role: 'none',
        tenant_role: 'editor',
        app_env: 'local',
        account_created_days: 0,
      },
      groupProps: { tenant: { tenant_created_days: 0 } },
      tenantId: tenant.id,
      sessionId: 'session-1',
    })
  })

  it('reads a staff user with no tenant', async () => {
    const { user } = await createTrackedStaff('admin')
    const context = await flagContextForUser(user.id, NONE, NONE)
    expect(context.personProps).toMatchObject({ platform_role: 'admin', tenant_role: 'none' })
    expect(context.groups).toEqual({})
    expect(context.groupProps).toEqual({})
  })

  it('gives tenant_role none in a tenant the user is not a member of', async () => {
    const owner = await createTrackedUser()
    const outsider = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Other Co',
      slug: `other-${randomUUID().slice(0, 8)}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    const context = await flagContextForUser(outsider.id, tenant.id, NONE)
    expect(context.personProps.tenant_role).toBe('none')
    expect(context.groups).toEqual({ tenant: tenant.id })
  })

  it('answers 404 for a user that does not exist', async () => {
    const failure = flagContextForUser(randomUUID(), NONE, NONE)
    await expect(failure).rejects.toBeInstanceOf(HttpError)
    await expect(failure).rejects.toMatchObject({ statusCode: 404, message: 'User not found' })
  })
})
