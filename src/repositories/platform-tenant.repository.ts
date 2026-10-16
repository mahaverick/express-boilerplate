/**
 * @file Staff-only, cross-tenant reads. Only `services/platform-*.service.ts` may
 * import this file (an eslint rule); every query excludes the platform tenant.
 * `list` lists soft-deleted tenants only when archived and asked for;
 * `findDetail` returns a tenant in any lifecycle state.
 */
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { TenantLifecycleState } from '@/constants/tenant.constants'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel, tenantSettingsModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import type { InvalidCursorError } from '@/errors/list-errors'
import { db, type DbExecutor } from '@/services/database.service'
import {
  defineList,
  listPage,
  searchCondition,
  textSort,
  timestampKey,
  timestampSort,
  type ListPage,
  type ListParams,
} from '@/utilities/list-page.utilities'

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
 * The staff tenant list's filters, defaults applied.
 */
export interface PlatformTenantFilters {
  state: TenantLifecycleState[]
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

const tenantSortName = sql<string>`lower(${tenantModel.name})`

/**
 * The staff tenant list: customer tenants in the asked states, searched by
 * name or slug. Archived tenants are soft-deleted, so `deleted_at` is
 * ignored for them only. Member counts include live members only.
 * @param search - The parsed search, or undefined.
 * @param filters - The states.
 * @returns The list definition.
 */
export function platformTenantList(search: string | undefined, filters: PlatformTenantFilters) {
  return defineList({
    name: 'platform-tenants',
    base: (executor, seek) => {
      // Built with a join so drizzle qualifies its columns; the one-table outer select renders them bare.
      const liveMembers = executor
        .select({ count: count() })
        .from(userMembershipModel)
        .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
        .where(and(eq(userMembershipModel.tenantId, tenantModel.id), isNull(userModel.deletedAt)))
      return executor
        .select({
          id: tenantModel.id,
          name: tenantModel.name,
          slug: tenantModel.slug,
          lifecycleState: tenantModel.lifecycleState,
          memberCount: sql<number>`(${liveMembers})`.mapWith(Number),
          createdAt: tenantModel.createdAt,
          sortName: tenantSortName,
          sortCreated: timestampKey(tenantModel.createdAt),
        })
        .from(tenantModel)
        .where(
          and(
            eq(tenantModel.isPlatform, false),
            inArray(tenantModel.lifecycleState, filters.state),
            // Only an archived row may be soft-deleted and still listed.
            sql`(${tenantModel.deletedAt} is null or ${tenantModel.lifecycleState} = 'archived')`,
            searchCondition(search, [sql`lower(${tenantModel.name})`, sql`${tenantModel.slug}`]),
            seek
          )
        )
        .$dynamic()
    },
    id: tenantModel.id,
    sorts: {
      name: [textSort(tenantSortName, 'asc', 'sortName')],
      created: [timestampSort(tenantModel.createdAt, 'asc', 'sortCreated')],
      '-created': [timestampSort(tenantModel.createdAt, 'desc', 'sortCreated')],
    },
    toItem: ({ sortName: _name, sortCreated: _created, ...tenant }): PlatformTenantRow => tenant,
  })
}

/**
 * Query access for the staff tenant list and detail.
 */
export class PlatformTenantRepository {
  /**
   * One page of the staff tenant list.
   * @param params - The parsed shared list params.
   * @param filters - The states.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async list(
    params: ListParams,
    filters: PlatformTenantFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<PlatformTenantRow>> {
    return listPage(executor, platformTenantList(params.search, filters), params)
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
