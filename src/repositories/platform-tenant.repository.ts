// src/repositories/platform-tenant.repository.ts
//
// Staff-only, cross-tenant reads. Only `services/platform-*.service.ts` may
// import this file (an eslint rule); every query excludes the platform
// tenant and soft-deleted tenants.
import { and, count, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { TenantLifecycleState } from '@/constants/tenant.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * The last row of a page: its lowercased name and id, the sort key.
 */
export interface PlatformTenantCursor {
  sortName: string
  id: string
}

/**
 * One tenant as the staff search returns it.
 */
export interface PlatformTenantRow {
  id: string
  name: string
  slug: string
  lifecycleState: TenantLifecycleState
  memberCount: number
  createdAt: Date
}

/**
 * A page of tenants and, when more remain, the cursor for the next one.
 */
export interface PlatformTenantPage {
  tenants: PlatformTenantRow[]
  nextCursor?: PlatformTenantCursor
}

/**
 * The search's inputs. `q` is matched as a literal substring.
 */
export interface PlatformTenantSearchOptions {
  limit: number
  q?: string | undefined
  cursor?: PlatformTenantCursor | undefined
}

/**
 * Escape LIKE's wildcards and its escape character, so `q` matches literally.
 * @param value - The raw search text.
 * @returns The text with `\`, `%` and `_` escaped by a backslash.
 */
function escapeLikePattern(value: string): string {
  return value.replaceAll(/[%\\_]/g, String.raw`\$&`)
}

/**
 * Query access for the staff tenant search.
 */
export class PlatformTenantRepository {
  /**
   * A page of every customer tenant, ordered by `(lower(name), id)`, optionally
   * filtered by a case-insensitive substring of the name or slug.
   * @param options - Page size, the search text and the cursor.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page, with `nextCursor` only when more rows remain.
   */
  async searchAll(
    options: PlatformTenantSearchOptions,
    executor: DbExecutor = db
  ): Promise<PlatformTenantPage> {
    const sortName = sql<string>`lower(${tenantModel.name})`
    const conditions: SQL[] = [isNull(tenantModel.deletedAt), eq(tenantModel.isPlatform, false)]
    if (options.q !== undefined) {
      const pattern = `%${escapeLikePattern(options.q)}%`
      conditions.push(
        sql`(lower(${tenantModel.name}) like lower(${pattern}) escape '\\' or ${tenantModel.slug} like lower(${pattern}) escape '\\')`
      )
    }
    if (options.cursor !== undefined) {
      conditions.push(
        sql`(lower(${tenantModel.name}), ${tenantModel.id}) > (${options.cursor.sortName}, ${options.cursor.id})`
      )
    }
    // Live members only, matching `UserMembershipRepository.listByTenant`. A
    // correlated subquery built with a join, so drizzle qualifies every
    // column: the outer select has one table and renders its columns bare.
    const liveMembers = executor
      .select({ count: count() })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(and(eq(userMembershipModel.tenantId, tenantModel.id), isNull(userModel.deletedAt)))
    const memberCount = sql<number>`(${liveMembers})`.mapWith(Number)

    const rows = await executor
      .select({
        id: tenantModel.id,
        name: tenantModel.name,
        slug: tenantModel.slug,
        lifecycleState: tenantModel.lifecycleState,
        memberCount,
        createdAt: tenantModel.createdAt,
        sortName,
      })
      .from(tenantModel)
      .where(and(...conditions))
      .orderBy(sortName, tenantModel.id)
      .limit(options.limit + 1)

    const hasMore = rows.length > options.limit
    if (hasMore) rows.pop()
    const tenants = rows.map(({ sortName: _sortName, ...tenant }) => tenant)
    const last = rows.at(-1)
    if (hasMore && last !== undefined) {
      return { tenants, nextCursor: { sortName: last.sortName, id: last.id } }
    }
    return { tenants }
  }
}
