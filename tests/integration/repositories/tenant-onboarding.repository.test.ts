/**
 * @file TenantRepository's onboarding columns against the real per-worker
 * Postgres: both create paths track the tenant, only the one with an owner
 * starts the clock, the clock starts once, and a dismissal is set and cleared.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const tenantRepository = new TenantRepository()
const tenantIds: string[] = []

afterEach(async () => {
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A slug unique to one call.
 * @returns The slug.
 */
function uniqueSlug(): string {
  return `onboarding-${randomUUID()}`
}

describe('TenantRepository onboarding columns', () => {
  it('create tracks the tenant and starts its clock at creation', async () => {
    const owner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Tracked Co',
      slug: uniqueSlug(),
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)

    expect(tenant.onboardingTracked).toBe(true)
    expect(tenant.onboardingStartedAt).toEqual(tenant.createdAt)
    expect(tenant.onboardingDismissedAt).toBeNull()
  })

  it('createWithoutOwner tracks the tenant and leaves the clock for the first owner', async () => {
    const tenant = await tenantRepository.createWithoutOwner({
      name: 'Awaiting Co',
      slug: uniqueSlug(),
    })
    tenantIds.push(tenant.id)

    expect(tenant.onboardingTracked).toBe(true)
    expect(tenant.onboardingStartedAt).toBeNull()
  })

  it('startOnboarding starts a tracked clock once, leaving updatedAt alone', async () => {
    const tenant = await tenantRepository.createWithoutOwner({
      name: 'Awaiting Co',
      slug: uniqueSlug(),
    })
    tenantIds.push(tenant.id)
    const first = new Date('2026-10-01T09:00:00.000Z')

    expect(await tenantRepository.startOnboarding(tenant.id, first)).toBe(true)
    expect(await tenantRepository.startOnboarding(tenant.id, new Date())).toBe(false)

    const reread = await tenantRepository.findById(tenant.id)
    expect(reread?.onboardingStartedAt).toEqual(first)
    expect(reread?.updatedAt).toEqual(tenant.updatedAt)
  })

  it('startOnboarding leaves an untracked tenant unstarted', async () => {
    const tenant = await tenantRepository.createWithoutOwner({
      name: 'Legacy Co',
      slug: uniqueSlug(),
    })
    tenantIds.push(tenant.id)
    await sql`update tenants set onboarding_tracked = false where id = ${tenant.id}`

    expect(await tenantRepository.startOnboarding(tenant.id, new Date())).toBe(false)
    const reread = await tenantRepository.findById(tenant.id)
    expect(reread?.onboardingStartedAt).toBeNull()
  })

  it('setOnboardingDismissed records and clears the dismissal', async () => {
    const owner = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Dismiss Co',
      slug: uniqueSlug(),
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)
    const at = new Date('2026-10-02T10:00:00.000Z')

    const dismissed = await tenantRepository.setOnboardingDismissed(tenant.id, owner.id, at)
    // eslint-disable-next-line unicorn/no-null -- null clears both columns
    const cleared = await tenantRepository.setOnboardingDismissed(tenant.id, null, null)

    expect(dismissed).toMatchObject({ onboardingDismissedBy: owner.id, onboardingDismissedAt: at })
    // eslint-disable-next-line unicorn/no-null -- both columns read back as null
    expect(cleared).toMatchObject({ onboardingDismissedBy: null, onboardingDismissedAt: null })
    expect(cleared?.updatedAt).toEqual(tenant.updatedAt)
  })
})
