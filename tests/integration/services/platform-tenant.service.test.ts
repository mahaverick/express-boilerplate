/**
 * @file platform-tenant.service: a tenant created by staff stands even when
 * its owner invitation mail cannot be queued; the caller hears emailSent: false.
 * Both tenant writes re-check the actor under lock in their transaction.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { createTenant, reissueOwnerInvitation } from '@/services/platform-tenant.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedModule } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const slugs: string[] = []

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
