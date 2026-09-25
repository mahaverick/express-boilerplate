// src/services/platform-tenant.service.ts
//
// "All tenants" for staff. The route has already checked the platform role;
// the per-user "your tenants" list stays in tenant.service.ts.
import {
  PlatformTenantRepository,
  type PlatformTenantRow,
} from '@/repositories/platform-tenant.repository'
import { encodeCursor } from '@/utilities/cursor.utilities'
import type { PlatformTenantSearchQuery } from '@/validators/platform.validators'

const platformTenantRepository = new PlatformTenantRepository()

/**
 * A page of search results and the opaque cursor for the next one.
 */
export interface PlatformTenantSearchPage {
  tenants: PlatformTenantRow[]
  nextCursor: string | null
}

/**
 * Search every customer tenant by name or slug, one keyset page at a time.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page, and `nextCursor` (null on the last page).
 */
export async function searchAll(
  query: PlatformTenantSearchQuery
): Promise<PlatformTenantSearchPage> {
  const page = await platformTenantRepository.searchAll({
    q: query.q,
    cursor: query.cursor,
    limit: query.limit,
  })
  return {
    tenants: page.tenants,
    nextCursor: page.nextCursor
      ? encodeCursor({ sortName: page.nextCursor.sortName, id: page.nextCursor.id })
      : // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null on the last page
        null,
  }
}
