/**
 * @file The tenant wire shapes carry no onboarding column: a member reads
 * onboarding only through its own endpoint.
 */
import { describe, expect, it } from 'vite-plus/test'
import type { Tenant } from '@/database/models/tenant.model'
import { toPublicTenant, toTenantDetail, toTenantListRow } from '@/presenters/tenant.presenter'

const ONBOARDING_KEYS = [
  'onboardingTracked',
  'onboardingStartedAt',
  'onboardingDismissedAt',
  'onboardingDismissedBy',
]

const tenant: Tenant = {
  id: 'tenant-1',
  name: 'Acme Inc',
  slug: 'acme',
  description: null,
  logo: null,
  website: null,
  lifecycleState: 'active',
  isPlatform: false,
  onboardingTracked: true,
  onboardingStartedAt: new Date('2026-10-01T00:00:00.000Z'),
  onboardingDismissedAt: new Date('2026-10-02T00:00:00.000Z'),
  onboardingDismissedBy: 'user-1',
  deletedAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
}

describe('tenant presenters', () => {
  it('toPublicTenant keeps every other column and drops the onboarding ones', () => {
    const shown = toPublicTenant(tenant)
    for (const key of ONBOARDING_KEYS) expect(shown).not.toHaveProperty(key)
    expect(shown).toMatchObject({ id: 'tenant-1', name: 'Acme Inc', slug: 'acme' })
  })

  it('toTenantListRow and toTenantDetail carry no onboarding column', () => {
    const row = toTenantListRow({ tenant, role: 'owner', joinedAt: tenant.createdAt })
    const detail = toTenantDetail(tenant, { role: 'owner', access: 'member' })
    for (const key of ONBOARDING_KEYS) {
      expect(row.tenant).not.toHaveProperty(key)
      expect(detail).not.toHaveProperty(key)
    }
    expect(detail).toMatchObject({ role: 'owner', access: 'member' })
  })
})
