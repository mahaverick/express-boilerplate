/**
 * @file Staff-only, cross-tenant reads. Only `services/platform-*.service.ts` may
 * import this file (an eslint rule); every query excludes the platform tenant;
 * soft-deleted tenants appear only when archived and asked for.
 */
import { and, count, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { PageDirection } from '@/constants/platform.constants'
import type { TenantLifecycleState } from '@/constants/tenant.constants'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel, tenantSettingsModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'
import { escapeLikePattern } from '@/utilities/like-pattern.utilities'

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
 * A page of tenants and the cursors either side of it, each only when rows lie that way.
 */
export interface PlatformTenantPage {
  tenants: PlatformTenantRow[]
  nextCursor?: PlatformTenantCursor
  prevCursor?: PlatformTenantCursor
}

/**
 * The search's inputs. `q` is matched as a literal substring. `states`
 * defaults to active and suspended, `direction` to next, so callers written
 * before either existed read exactly what they read before.
 */
export interface PlatformTenantSearchOptions {
  limit: number
  states?: readonly TenantLifecycleState[] | undefined
  direction?: PageDirection | undefined
  q?: string | undefined
  cursor?: PlatformTenantCursor | undefined
}

/**
 * One customer tenant as the staff detail page shows it.
 */
export interface PlatformTenantDetailRow {
  id: string
  name: string
  slug: string
  description: string | null
  website: string | null
  logo: string | null
  lifecycleState: TenantLifecycleState
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  settings: { timezone: string; locale: string }
  memberCount: number
  /**
   * Live owners, each with whether they can still sign in.
   */
  owners: {
    userId: string
    email: string
    firstName: string | null
    lastName: string | null
    active: boolean
  }[]
  pendingInvitationCount: number
  pendingOwnerInvitation: { id: string; email: string; expiresAt: Date } | null
}

/**
 * The cursor that points at a row.
 * @param row - A row carrying its sort key.
 * @param row.sortName - The row's lowercased name.
 * @param row.id - The row's id.
 * @returns The cursor.
 */
function cursorOf({ sortName, id }: PlatformTenantCursor): PlatformTenantCursor {
  return { sortName, id }
}

/**
 * Query access for the staff tenant search.
 */
export class PlatformTenantRepository {
  /**
   * A page of customer tenants in `states`, ordered by `(lower(name), id)`,
   * optionally filtered by a case-insensitive substring of the name or slug.
   * Archived tenants are soft-deleted, so `deleted_at` is ignored for them
   * only. `direction: 'prev'` reads the rows before `cursor`, newest-first,
   * and returns them in ascending order. Member counts include live members only.
   * @param options - Page size, states, direction, search text and cursor.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page, with `nextCursor`/`prevCursor` only when rows remain that way.
   */
  async searchAll(
    options: PlatformTenantSearchOptions,
    executor: DbExecutor = db
  ): Promise<PlatformTenantPage> {
    const sortName = sql<string>`lower(${tenantModel.name})`
    const states = options.states ?? (['active', 'suspended'] as const)
    const conditions: SQL[] = [
      eq(tenantModel.isPlatform, false),
      inArray(tenantModel.lifecycleState, [...states]),
      // Only an archived row may be soft-deleted and still listed.
      sql`(${tenantModel.deletedAt} is null or ${tenantModel.lifecycleState} = 'archived')`,
    ]
    if (options.q !== undefined) {
      const pattern = `%${escapeLikePattern(options.q)}%`
      conditions.push(
        sql`(lower(${tenantModel.name}) like lower(${pattern}) escape '\\' or ${tenantModel.slug} like lower(${pattern}) escape '\\')`
      )
    }
    const isPrevious = options.direction === 'prev'
    if (options.cursor !== undefined) {
      const key = sql`(lower(${tenantModel.name}), ${tenantModel.id})`
      const at = sql`(${options.cursor.sortName}, ${options.cursor.id})`
      conditions.push(isPrevious ? sql`${key} < ${at}` : sql`${key} > ${at}`)
    }
    // Built with a join so drizzle qualifies its columns; the one-table outer select renders them bare.
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
      .orderBy(
        ...(isPrevious ? [desc(sortName), desc(tenantModel.id)] : [sortName, tenantModel.id])
      )
      .limit(options.limit + 1)

    const hasMoreThisWay = rows.length > options.limit
    if (hasMoreThisWay) rows.pop()
    if (isPrevious) rows.reverse()
    const first = rows.at(0)
    const last = rows.at(-1)
    // A page read from a cursor has rows on the side it came from; an empty one hands that cursor back.
    const hasBefore = isPrevious ? hasMoreThisWay : options.cursor !== undefined
    const hasAfter = isPrevious ? options.cursor !== undefined : hasMoreThisWay
    const nextCursor = last === undefined ? options.cursor : cursorOf(last)
    const previousCursor = first === undefined ? options.cursor : cursorOf(first)
    return {
      tenants: rows.map(({ sortName: _sortName, ...tenant }) => tenant),
      ...(hasAfter && nextCursor && { nextCursor }),
      ...(hasBefore && previousCursor && { prevCursor: previousCursor }),
    }
  }

  /**
   * One customer tenant in any lifecycle state, with its settings, live
   * owners (each flagged active or not), live member count and pending
   * invitations. The platform tenant is never returned.
   * @param id - The tenant id.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The detail, or undefined when there is no such customer tenant.
   */
  async findDetail(
    id: string,
    executor: DbExecutor = db
  ): Promise<PlatformTenantDetailRow | undefined> {
    const [tenant] = await executor
      .select({
        id: tenantModel.id,
        name: tenantModel.name,
        slug: tenantModel.slug,
        description: tenantModel.description,
        website: tenantModel.website,
        logo: tenantModel.logo,
        lifecycleState: tenantModel.lifecycleState,
        createdAt: tenantModel.createdAt,
        updatedAt: tenantModel.updatedAt,
        deletedAt: tenantModel.deletedAt,
        timezone: tenantSettingsModel.timezone,
        locale: tenantSettingsModel.locale,
      })
      .from(tenantModel)
      .innerJoin(tenantSettingsModel, eq(tenantSettingsModel.tenantId, tenantModel.id))
      .where(and(eq(tenantModel.id, id), eq(tenantModel.isPlatform, false)))
      .limit(1)
    if (!tenant) return undefined

    const liveMember = and(eq(userMembershipModel.tenantId, id), isNull(userModel.deletedAt))
    const [members] = await executor
      .select({ count: count() })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(liveMember)
    const owners = await executor
      .select({
        userId: userModel.id,
        email: userModel.email,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
        active: userModel.active,
      })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(and(liveMember, eq(userMembershipModel.role, 'owner')))
      .orderBy(userModel.email)

    const redeemable = and(
      eq(tenantInvitationModel.tenantId, id),
      isNull(tenantInvitationModel.acceptedAt),
      isNull(tenantInvitationModel.revokedAt),
      gt(tenantInvitationModel.expiresAt, sql`now()`)
    )
    const [pending] = await executor
      .select({ count: count() })
      .from(tenantInvitationModel)
      .where(redeemable)
    const [ownerInvitation] = await executor
      .select({
        id: tenantInvitationModel.id,
        email: tenantInvitationModel.email,
        expiresAt: tenantInvitationModel.expiresAt,
      })
      .from(tenantInvitationModel)
      .where(and(redeemable, eq(tenantInvitationModel.role, 'owner')))
      .orderBy(desc(tenantInvitationModel.createdAt))
      .limit(1)

    const { timezone, locale, ...columns } = tenant
    return {
      ...columns,
      settings: { timezone, locale },
      memberCount: members?.count ?? 0,
      owners,
      pendingInvitationCount: pending?.count ?? 0,
      // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null when there is none
      pendingOwnerInvitation: ownerInvitation ?? null,
    }
  }
}
