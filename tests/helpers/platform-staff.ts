// tests/helpers/platform-staff.ts
//
// Staff are users with a membership in the seeded platform tenant. These
// helpers read that tenant and make a user staff, for tests that exercise
// platform access.
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * The seeded platform tenant.
 * @returns Its row.
 * @throws {Error} When the platform tenant is missing.
 */
export async function platformTenant(): Promise<Tenant> {
  const platform = await tenantRepository.findPlatformTenant()
  if (!platform) throw new Error('setup: migration 0016 seeds the platform tenant')
  return platform
}

/**
 * Make a user staff with `role`. Deleting the user cascades to this membership.
 * @param userId - The user.
 * @param role - The platform role.
 */
export async function makeStaff(userId: string, role: MembershipRole): Promise<void> {
  const platform = await platformTenant()
  await userMembershipRepository.create({ userId, tenantId: platform.id, role })
}
