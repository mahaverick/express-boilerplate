/**
 * @file Staff-only, cross-tenant reads of users. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule).
 * Reads exclude soft-deleted users unless a caller asks for them (the
 * `deleted` list status, `findRecord`'s `includeDeleted`). The membership
 * count and `listMemberships` leave out the platform tenant, whose membership
 * is reported as `platformRole`.
 */
import { and, count, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { lastSignInSort, userFullNameSearch, userModel } from '@/database/models/user.model'
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
import { sortAtField } from '@/validators/cursor.validators'

/**
 * One user as the staff search and detail return it: an explicit
 * projection, never the full row.
 */
export interface PlatformUserRecord {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  active: boolean
  emailVerifiedAt: Date | null
  lastLoggedInAt: Date | null
  createdAt: Date
  /**
   * When the user was soft-deleted; null for a live user.
   */
  deletedAt: Date | null
  /**
   * The user's role in the platform tenant, or null when not staff.
   */
  platformRole: MembershipRole | null
  /**
   * Memberships of live customer tenants (archived and the platform tenant excluded).
   */
  membershipCount: number
}

/**
 * The staff user list's filters, defaults applied: `active`/`inactive`
 * select live users by `users.active`, `deleted` soft-deleted ones.
 */
export interface PlatformUserFilters {
  status: ('active' | 'inactive' | 'deleted')[]
  verified?: boolean | undefined
  signedIn?: boolean | undefined
  staff?: boolean | undefined
}

/**
 * The name fields of one user, for labelling who did something.
 */
export interface PlatformUserLabel {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * One customer-tenant membership on the user detail.
 */
export interface PlatformUserMembership {
  tenantId: string
  tenantName: string
  tenantSlug: string
  lifecycleState: TenantLifecycleState
  role: MembershipRole
  joinedAt: Date
}

/**
 * One pending, unexpired invitation to the user's address.
 */
export interface PlatformUserPendingInvitation {
  id: string
  tenantId: string
  tenantName: string
  /**
   * The tenant's slug, so Apex can tell a staff invitation (the platform tenant's) from a customer one.
   */
  tenantSlug: string
  role: MembershipRole
  expiresAt: Date
  /**
   * When the invitation was last mailed, or null for a row never stamped.
   */
  lastSentAt: Date | null
}

/**
 * A live tenant the user owns.
 */
export interface OwnedTenant {
  tenantId: string
  tenantName: string
  isPlatform: boolean
}

/**
 * The record columns plus the sort key, over `users` alone, with the
 * correlated platform-role subquery the staff filter reuses.
 * @param executor - Where the query will run.
 * @returns `columns`, the selection for `executor.select(...)`, and `platformRoleQuery`, the subquery behind its `platformRole` column.
 */
function recordSelection(executor: DbExecutor) {
  const platformRoleQuery = executor
    .select({ role: userMembershipModel.role })
    .from(userMembershipModel)
    .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
    .where(and(eq(userMembershipModel.userId, userModel.id), eq(tenantModel.isPlatform, true)))
  const membershipCountQuery = executor
    .select({ count: count() })
    .from(userMembershipModel)
    .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
    .where(
      and(
        eq(userMembershipModel.userId, userModel.id),
        eq(tenantModel.isPlatform, false),
        isNull(tenantModel.deletedAt)
      )
    )
  return {
    platformRoleQuery,
    columns: {
      id: userModel.id,
      email: userModel.email,
      firstName: userModel.firstName,
      lastName: userModel.lastName,
      active: userModel.active,
      emailVerifiedAt: userModel.emailVerifiedAt,
      lastLoggedInAt: userModel.lastLoggedInAt,
      createdAt: userModel.createdAt,
      deletedAt: userModel.deletedAt,
      platformRole: sql<MembershipRole | null>`(${platformRoleQuery})`,
      membershipCount: sql<number>`(${membershipCountQuery})`.mapWith(Number),
      sortEmail: sql<string>`lower(${userModel.email})`,
    },
  }
}

const userSortEmail = sql<string>`lower(${userModel.email})`

/**
 * The status filter: any of the asked statuses.
 * @param statuses - The asked statuses, at least one.
 * @returns The condition.
 */
function statusCondition(statuses: PlatformUserFilters['status']): SQL | undefined {
  return or(
    ...statuses.map((status) =>
      status === 'deleted'
        ? isNotNull(userModel.deletedAt)
        : and(isNull(userModel.deletedAt), eq(userModel.active, status === 'active'))
    )
  )
}

/**
 * The verified filter: users with (or without) a verified email.
 * @param verified - The asked value, or undefined for no filter.
 * @returns The condition, or undefined.
 */
function verifiedCondition(verified: boolean | undefined): SQL | undefined {
  if (verified === undefined) return undefined
  return verified ? isNotNull(userModel.emailVerifiedAt) : isNull(userModel.emailVerifiedAt)
}

/**
 * The signed-in filter: users with (or without) a recorded sign-in.
 * @param signedIn - The asked value, or undefined for no filter.
 * @returns The condition, or undefined.
 */
function signedInCondition(signedIn: boolean | undefined): SQL | undefined {
  if (signedIn === undefined) return undefined
  return signedIn ? isNotNull(userModel.lastLoggedInAt) : isNull(userModel.lastLoggedInAt)
}

/**
 * The staff filter: users with (or without) a platform role.
 * @param staff - The asked value, or undefined for no filter.
 * @param platformRoleQuery - The correlated platform-role subquery.
 * @returns The condition, or undefined.
 */
function staffCondition(
  staff: boolean | undefined,
  platformRoleQuery: SQL | ReturnType<typeof recordSelection>['platformRoleQuery']
): SQL | undefined {
  if (staff === undefined) return undefined
  return staff ? sql`exists (${platformRoleQuery})` : sql`not exists (${platformRoleQuery})`
}

/**
 * The staff user list, searched by email, first and last name, and full name.
 * @param search - The parsed search, or undefined.
 * @param filters - Status, verified, signed in and staff.
 * @returns The list definition.
 */
export function platformUserList(search: string | undefined, filters: PlatformUserFilters) {
  return defineList({
    name: 'platform-users',
    base: (executor, seek) => {
      const searchExpressions = [
        sql`lower(${userModel.email})`,
        sql`lower(${userModel.firstName})`,
        sql`lower(${userModel.lastName})`,
        userFullNameSearch(userModel.firstName, userModel.lastName),
      ]
      const { columns, platformRoleQuery } = recordSelection(executor)
      return executor
        .select({
          ...columns,
          sortCreated: timestampKey(userModel.createdAt),
          sortLastSignIn: sql<string>`coalesce(${timestampKey(userModel.lastLoggedInAt)}, '-infinity')`,
        })
        .from(userModel)
        .where(
          and(
            statusCondition(filters.status),
            searchCondition(search, searchExpressions),
            verifiedCondition(filters.verified),
            signedInCondition(filters.signedIn),
            staffCondition(filters.staff, platformRoleQuery),
            seek
          )
        )
        .$dynamic()
    },
    id: userModel.id,
    sorts: {
      email: [textSort(userSortEmail, 'asc', 'sortEmail')],
      created: [timestampSort(userModel.createdAt, 'asc', 'sortCreated')],
      '-created': [timestampSort(userModel.createdAt, 'desc', 'sortCreated')],
      '-lastSignIn': [
        {
          expression: lastSignInSort(userModel.lastLoggedInAt),
          direction: 'desc',
          key: 'sortLastSignIn',
          value: z.union([sortAtField, z.literal('-infinity')]),
          bind: (value) => sql`${value}::timestamptz`,
        },
      ],
    },
    toItem: ({
      sortEmail: _email,
      sortCreated: _created,
      sortLastSignIn: _lastSignIn,
      ...user
    }): PlatformUserRecord => user,
  })
}

/**
 * Query access for the staff user directory.
 */
export class PlatformUserRepository {
  /**
   * One page of the staff user list.
   * @param params - The parsed shared list params.
   * @param filters - Status, verified, signed in and staff.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async list(
    params: ListParams,
    filters: PlatformUserFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<PlatformUserRecord>> {
    return listPage(executor, platformUserList(params.search, filters), params)
  }

  /**
   * One user as the search returns it.
   * @param userId - The user's id.
   * @param options - `includeDeleted` also finds a soft-deleted user (the detail page and purge read one).
   * @param options.includeDeleted - Whether a soft-deleted user is found.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The record, or undefined when the user is unknown (or soft-deleted, unless asked).
   */
  async findRecord(
    userId: string,
    options: { includeDeleted?: boolean } = {},
    executor: DbExecutor = db
  ): Promise<PlatformUserRecord | undefined> {
    const { columns } = recordSelection(executor)
    const rows = await executor
      .select(columns)
      .from(userModel)
      .where(
        options.includeDeleted === true
          ? eq(userModel.id, userId)
          : and(eq(userModel.id, userId), isNull(userModel.deletedAt))
      )
      .limit(1)
    const [record] = rows.map(({ sortEmail: _sortEmail, ...user }) => user)
    return record
  }

  /**
   * The user's customer-tenant memberships, archived tenants included (the
   * detail page shows history), the platform tenant excluded. Ordered by
   * tenant name, then id.
   * @param userId - The user's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per membership.
   */
  async listMemberships(
    userId: string,
    executor: DbExecutor = db
  ): Promise<PlatformUserMembership[]> {
    return executor
      .select({
        tenantId: tenantModel.id,
        tenantName: tenantModel.name,
        tenantSlug: tenantModel.slug,
        lifecycleState: tenantModel.lifecycleState,
        role: userMembershipModel.role,
        joinedAt: userMembershipModel.createdAt,
      })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
      .where(and(eq(userMembershipModel.userId, userId), eq(tenantModel.isPlatform, false)))
      .orderBy(sql`lower(${tenantModel.name})`, tenantModel.id)
  }

  /**
   * Pending, unexpired invitations to an address, in live tenants (the
   * platform tenant included: a staff invitation is one), soonest expiry first.
   * @param email - The address, in any case.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The invitations; never the token hash.
   */
  async listPendingInvitations(
    email: string,
    executor: DbExecutor = db
  ): Promise<PlatformUserPendingInvitation[]> {
    return executor
      .select({
        id: tenantInvitationModel.id,
        tenantId: tenantModel.id,
        tenantName: tenantModel.name,
        tenantSlug: tenantModel.slug,
        role: tenantInvitationModel.role,
        expiresAt: tenantInvitationModel.expiresAt,
        lastSentAt: tenantInvitationModel.lastSentAt,
      })
      .from(tenantInvitationModel)
      .innerJoin(tenantModel, eq(tenantModel.id, tenantInvitationModel.tenantId))
      .where(
        and(
          sql`lower(${tenantInvitationModel.email}) = lower(${email})`,
          isNull(tenantInvitationModel.acceptedAt),
          isNull(tenantInvitationModel.revokedAt),
          gt(tenantInvitationModel.expiresAt, sql`now()`),
          isNull(tenantModel.deletedAt)
        )
      )
      .orderBy(tenantInvitationModel.expiresAt, tenantInvitationModel.id)
  }

  /**
   * The live tenants the user owns, the platform tenant included, in
   * tenant-id order.
   * @param userId - The user's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The owned tenants.
   */
  async listOwnedTenants(userId: string, executor: DbExecutor = db): Promise<OwnedTenant[]> {
    return executor
      .select({
        tenantId: tenantModel.id,
        tenantName: tenantModel.name,
        isPlatform: tenantModel.isPlatform,
      })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
      .where(
        and(
          eq(userMembershipModel.userId, userId),
          eq(userMembershipModel.role, 'owner'),
          isNull(tenantModel.deletedAt)
        )
      )
      .orderBy(tenantModel.id)
  }

  /**
   * The names and addresses of the users with these ids, soft-deleted users
   * included. An id with no user row (a purged user, or an id that was
   * never a user's) is left out.
   * @param ids - The user ids.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per user found, in no particular order.
   */
  async listLabels(
    ids: readonly string[],
    executor: DbExecutor = db
  ): Promise<PlatformUserLabel[]> {
    if (ids.length === 0) return []
    return executor
      .select({
        id: userModel.id,
        email: userModel.email,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
      })
      .from(userModel)
      .where(inArray(userModel.id, [...ids]))
  }
}
