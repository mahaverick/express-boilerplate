/**
 * @file platform-tenant.service: a tenant created by staff stands even when
 * its owner invitation mail cannot be queued; the caller hears emailSent: false.
 * Both tenant writes re-check the actor under lock in their transaction. An
 * owner re-issue racing the old invitee's accept never leaves both an owner
 * and a new pending owner invitation. Seams via withMutatedMethod, no sleeps.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { sql, withTransaction, type DbTransaction } from '@/services/database.service'
import { createTenant, reissueOwnerInvitation } from '@/services/platform-tenant.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept, createOwnerInvitation } from '@/services/tenant-invitation.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const slugs: string[] = []

// The owner invitations this file queues must not linger under the worker's key prefix for the next file.
afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

afterEach(async () => {
  await truncateAuditLogs()
  if (slugs.length > 0) await sql`delete from tenants where slug = any(${slugs})`
  slugs.length = 0
  await deleteTrackedUsers()
})

describe('createTenant mail failure', () => {
  it('keeps the tenant and its pending owner invitation, answering emailSent: false', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const slug = `mailfail-${randomUUID().slice(0, 8)}`
    slugs.push(slug)

    await withMutatedModule(
      '@/jobs/email.job',
      {
        addEmailJob: (): Promise<never> => Promise.reject(new Error('queue unavailable')),
      },
      () => import('@/services/platform-tenant.service'),
      async ({ createTenant }) => {
        const result = await createTenant(
          { userId: admin.id },
          { name: 'Mail Fail', slug, ownerEmail: `o-${randomUUID()}@example.test` }
        )
        expect(result.emailSent).toBe(false)
        expect(result.tenant.pendingOwnerInvitation).not.toBeNull()
      }
    )

    expect(await sql`select id from tenants where slug = ${slug}`).toHaveLength(1)
  })
})

describe('the actor re-check under lock', () => {
  it('answers 401 to a staff admin whose account was deactivated, and writes nothing', async () => {
    const { user: admin } = await createTrackedStaff('admin', { active: false })
    const slug = `inactive-${randomUUID().slice(0, 8)}`
    slugs.push(slug)

    await expect(
      createTenant(
        { userId: admin.id },
        { name: 'Nope', slug, ownerEmail: `o-${randomUUID()}@example.test` }
      )
    ).rejects.toMatchObject({ statusCode: 401, message: 'Account no longer exists or is inactive' })

    expect(await sql`select id from tenants where slug = ${slug}`).toHaveLength(0)
  })

  it('answers 401 to a soft-deleted staff admin on a re-issue', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const slug = `deleted-${randomUUID().slice(0, 8)}`
    slugs.push(slug)
    const { tenant } = await createTenant(
      { userId: admin.id },
      { name: 'Reissue', slug, ownerEmail: `o-${randomUUID()}@example.test` }
    )
    await sql`update users set deleted_at = now() where id = ${admin.id}`

    await expect(
      reissueOwnerInvitation(
        { userId: admin.id },
        tenant.id,
        `n-${randomUUID()}@example.test`,
        'why'
      )
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('answers 404 to a user who is no longer staff', async () => {
    const user = await createTrackedUser()
    const slug = `nostaff-${randomUUID().slice(0, 8)}`
    slugs.push(slug)

    await expect(
      createTenant(
        { userId: user.id },
        { name: 'Nope', slug, ownerEmail: `o-${randomUUID()}@example.test` }
      )
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(await sql`select id from tenants where slug = ${slug}`).toHaveLength(0)
  })
})

describe('createOwnerInvitation', () => {
  it('refuses the platform tenant, writing nothing', async () => {
    const { user: admin } = await createTrackedStaff('owner')
    const platform = await platformTenant()
    const email = `p-${randomUUID()}@example.test`

    await expect(
      withTransaction((tx) =>
        createOwnerInvitation({ userId: admin.id }, platform.id, email, 'why', tx)
      )
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(await sql`select id from tenant_invitations where email = ${email}`).toHaveLength(0)
  })
})

describe('owner re-issue vs the old invitee accepting', () => {
  it('answers 409 and writes nothing when the accept commits an owner mid-re-issue', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const slug = `race-${randomUUID().slice(0, 8)}`
    slugs.push(slug)
    const tenant = await tenantRepository.createWithoutOwner({ name: 'Race', slug })
    const rawToken = randomUUID()
    await invitationRepository.createPending({
      tenantId: tenant.id,
      email: invitee.email,
      role: 'owner',
      tokenHash: hashToken(rawToken),
      invitedBy: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Pause the accept after it claimed the invitation and inserted the owner membership, before commit.
    const reached = deferred<number>()
    const release = deferred()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
    const realInsert = UserMembershipRepository.prototype.insertIfAbsent
    const pausingInsert: typeof realInsert = async function (
      this: UserMembershipRepository,
      ...arguments_
    ) {
      const inserted = await realInsert.apply(this, arguments_)
      reached.resolve(await backendPid(arguments_[1] as DbTransaction))
      await release.promise
      return inserted
    }

    let outcomes: PromiseSettledResult<unknown>[] = []
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'insertIfAbsent',
      pausingInsert,
      async () => {
        const accepting = accept(rawToken, invitee.id)
        const acceptPid = await untilSignalled(reached.promise, accepting, 'accept')
        const reissuing = reissueOwnerInvitation(
          { userId: admin.id },
          tenant.id,
          `new-${randomUUID()}@example.test`,
          'Customer asked us to resend'
        )
        // The re-issue queues behind the accept's claim of the invitation row.
        expect(await waitForWaiter(acceptPid, reissuing)).toBe(true)
        release.resolve()
        outcomes = await Promise.allSettled([accepting, reissuing])
      }
    )

    expect(outcomes[0]?.status).toBe('fulfilled')
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: {
        statusCode: 409,
        message: 'This tenant already has an owner; manage it from Members.',
      },
    })
    const owners = await sql`select user_id from user_memberships
      where tenant_id = ${tenant.id} and role = 'owner'`
    expect(owners.map((row) => row.user_id as string)).toEqual([invitee.id])
    const pending = await sql`select id from tenant_invitations
      where tenant_id = ${tenant.id} and accepted_at is null and revoked_at is null`
    expect(pending).toHaveLength(0)
    const audit = await sql<{ action: string }[]>`select action from audit_logs
      where tenant_id = ${tenant.id} order by occurred_at, id`
    expect(audit.map((row) => row.action)).toEqual(['invitation.accepted'])
  })

  it('makes the old invitation unusable once a re-issue commits first', async () => {
    const { user: admin } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const slug = `race2-${randomUUID().slice(0, 8)}`
    slugs.push(slug)
    const tenant = await tenantRepository.createWithoutOwner({ name: 'Race Two', slug })
    const rawToken = randomUUID()
    await invitationRepository.createPending({
      tenantId: tenant.id,
      email: invitee.email,
      role: 'owner',
      tokenHash: hashToken(rawToken),
      invitedBy: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await reissueOwnerInvitation(
      { userId: admin.id },
      tenant.id,
      `new-${randomUUID()}@example.test`,
      'Customer asked us to resend'
    )

    await expect(accept(rawToken, invitee.id)).rejects.toMatchObject({ statusCode: 404 })
    const owners = await sql`select user_id from user_memberships where tenant_id = ${tenant.id}`
    expect(owners).toHaveLength(0)
  })
})
