/**
 * @file Staff reads and writes over every customer tenant. The route has already checked the platform role; the per-user "your tenants" list stays in tenant.service.ts.
 */
import { statesFor } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import {
  PlatformTenantRepository,
  type PlatformTenantCursor,
  type PlatformTenantDetailRow,
  type PlatformTenantRow,
} from '@/repositories/platform-tenant.repository'
import { encodeCursor } from '@/utilities/cursor.utilities'
import type { PlatformTenantSearchQuery } from '@/validators/platform.validators'

const platformTenantRepository = new PlatformTenantRepository()

/**
 * A page of search results and the opaque cursors either side of it.
 */
export interface PlatformTenantSearchPage {
  tenants: PlatformTenantRow[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One customer tenant, in any state, for the staff detail page.
 */
export type PlatformTenantDetail = PlatformTenantDetailRow

/**
 * An encoded cursor, or JSON null when there is none.
 * @param cursor - The keys, when rows lie that way.
 * @returns The opaque cursor, or null.
 */
function encoded(cursor: PlatformTenantCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at either end
  return cursor ? encodeCursor({ sortName: cursor.sortName, id: cursor.id }) : null
}

/**
 * Search every customer tenant by name or slug and lifecycle state, one keyset page at a time.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page, and `nextCursor`/`prevCursor` (null at that end).
 */
export async function searchAll(
  query: PlatformTenantSearchQuery
): Promise<PlatformTenantSearchPage> {
  const page = await platformTenantRepository.searchAll({
    q: query.q,
    cursor: query.cursor,
    limit: query.limit,
    direction: query.direction,
    states: statesFor(query.state),
  })
  return {
    tenants: page.tenants,
    nextCursor: encoded(page.nextCursor),
    prevCursor: encoded(page.prevCursor),
  }
}

/**
 * One customer tenant in any lifecycle state.
 * @param tenantId - The tenant id.
 * @returns The detail.
 * @throws {HttpError} 404 when there is no such customer tenant (the platform tenant included).
 */
export async function getTenantDetail(tenantId: string): Promise<PlatformTenantDetail> {
  const detail = await platformTenantRepository.findDetail(tenantId)
  if (!detail) throw new HttpError('Tenant not found', 404)
  return detail
}
