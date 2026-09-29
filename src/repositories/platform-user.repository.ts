/**
 * @file Staff-only, cross-tenant reads of users. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule).
 * Reads exclude soft-deleted users unless a caller asks for them (the
 * `deleted` search status, `findRecord`'s `includeDeleted`); membership
 * counts and lists never include the platform tenant, whose membership is
 * reported as the platform role.
 */
import { and, asc, count, desc, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import type { PageDirection } from '@/constants/platform.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'
import { escapeLikePattern } from '@/utilities/like-pattern.utilities'

/**
 * A row's sort key: its lowercased email and id.
 */
export interface PlatformUserCursor {
  sortEmail: string
  id: string
}

/**
 * One user as the staff search and detail return it. Never carries the
 * password hash.
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
 * A page of users and the cursors either side of it.
 */
export interface PlatformUserRecordPage {
  users: PlatformUserRecord[]
  nextCursor?: PlatformUserCursor
  prevCursor?: PlatformUserCursor
}

/**
 * The search's inputs. `q` is matched as a literal, case-insensitive substring.
 */
export interface PlatformUserSearchOptions {
  limit: number
  direction: PageDirection
  q?: string | undefined
  /**
   * `active`/`inactive` filter live users by `users.active`; `deleted` lists only soft-deleted ones.
   */
  status?: 'active' | 'inactive' | 'deleted' | undefined
  verified?: boolean | undefined
  staff?: boolean | undefined
  cursor?: PlatformUserCursor | undefined
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
  role: MembershipRole
  expiresAt: Date
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
 * The record columns plus the sort key, over `users` alone. The correlated
 * subqueries are built with a join, so drizzle qualifies `users.id` inside
 * them; the one-table outer select renders its own columns bare.
 * @param executor - Where the query will run.
 * @returns The selection for `executor.select(...)`.
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

/**
 * A row's sort key.
 * @param row - A selected row.
 * @param row.sortEmail - Its lowercased email.
 * @param row.id - Its id.
 * @returns The cursor pointing at it.
 */
function keyOf(row: { sortEmail: string; id: string }): PlatformUserCursor {
  return { sortEmail: row.sortEmail, id: row.id }
}

/**
 * The search's filters, before the cursor: soft-delete scope (by `status`),
 * `q`, `active`, `verified` and `staff`.
 * @param options - The search's inputs.
 * @param platformRoleQuery - The correlated platform-role subquery, for the staff filter.
 * @returns The conditions to AND together.
 */
function filterConditions(
  options: PlatformUserSearchOptions,
  platformRoleQuery: SQL | ReturnType<typeof recordSelection>['platformRoleQuery']
): SQL[] {
  const conditions: SQL[] = [
    options.status === 'deleted' ? isNotNull(userModel.deletedAt) : isNull(userModel.deletedAt),
  ]
  if (options.q !== undefined) {
    const pattern = `%${escapeLikePattern(options.q)}%`
    conditions.push(
      sql`(lower(${userModel.email}) like lower(${pattern}) escape '\\' or lower(coalesce(${userModel.firstName}, '')) like lower(${pattern}) escape '\\' or lower(coalesce(${userModel.lastName}, '')) like lower(${pattern}) escape '\\')`
    )
  }
  if (options.status === 'active' || options.status === 'inactive') {
    conditions.push(eq(userModel.active, options.status === 'active'))
  }
  if (options.verified !== undefined) {
    conditions.push(
      options.verified ? isNotNull(userModel.emailVerifiedAt) : isNull(userModel.emailVerifiedAt)
    )
  }
  if (options.staff !== undefined) {
    conditions.push(
      options.staff ? sql`exists (${platformRoleQuery})` : sql`not exists (${platformRoleQuery})`
    )
  }
  return conditions
}

/**
 * The keyset condition: rows after the cursor, or before it for `prev`.
 * @param cursor - The cursor.
 * @param isPrevious - Whether the page reads backwards.
 * @returns The condition.
 */
function cursorCondition(cursor: PlatformUserCursor, isPrevious: boolean): SQL {
  return isPrevious
    ? sql`(lower(${userModel.email}), ${userModel.id}) < (${cursor.sortEmail}, ${cursor.id})`
    : sql`(lower(${userModel.email}), ${userModel.id}) > (${cursor.sortEmail}, ${cursor.id})`
}

/**
 * The cursors either side of a page, rows already in ascending order.
 * `prevCursor` is absent on the first page; a page read from a cursor that
 * comes back empty hands that cursor back on the side it came from, so the
 * client can always step back.
 * @param rows - The page's rows, ascending.
 * @param hasMore - Whether a row beyond the page exists in the read direction.
 * @param options - The search's inputs.
 * @returns The cursors to set.
 */
function pageCursors(
  rows: readonly { sortEmail: string; id: string }[],
  hasMore: boolean,
  options: PlatformUserSearchOptions
): Pick<PlatformUserRecordPage, 'nextCursor' | 'prevCursor'> {
  const first = rows[0]
  const last = rows.at(-1)
  if (options.direction === 'prev') {
    const next = last ? keyOf(last) : options.cursor
    return {
      ...(hasMore && first && { prevCursor: keyOf(first) }),
      ...(next && { nextCursor: next }),
    }
  }
  const previous = first ? keyOf(first) : options.cursor
  return {
    ...(hasMore && last && { nextCursor: keyOf(last) }),
    ...(options.cursor !== undefined && previous && { prevCursor: previous }),
  }
}

/**
 * Query access for the staff user directory.
 */
export class PlatformUserRepository {
  /**
   * A page of users, ordered by `(lower(email), id)`. `next` reads the rows
   * after the cursor; `prev` reads the rows before it, newest-first, and
   * reverses them, so every page comes back in ascending order. See
   * `pageCursors` for when each returned cursor is set.
   * @param options - Filters, page size, direction and cursor.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page and its cursors.
   */
  async search(
    options: PlatformUserSearchOptions,
    executor: DbExecutor = db
  ): Promise<PlatformUserRecordPage> {
    const { columns, platformRoleQuery } = recordSelection(executor)
    const isPrevious = options.direction === 'prev'
    const conditions = filterConditions(options, platformRoleQuery)
    if (options.cursor !== undefined) conditions.push(cursorCondition(options.cursor, isPrevious))

    const rows = await executor
      .select(columns)
      .from(userModel)
      .where(and(...conditions))
      .orderBy(
        ...(isPrevious
          ? [desc(columns.sortEmail), desc(userModel.id)]
          : [asc(columns.sortEmail), asc(userModel.id)])
      )
      .limit(options.limit + 1)

    const hasMore = rows.length > options.limit
    if (hasMore) rows.pop()
    if (isPrevious) rows.reverse()
    return {
      users: rows.map(({ sortEmail: _sortEmail, ...user }) => user),
      ...pageCursors(rows, hasMore, options),
    }
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
        role: tenantInvitationModel.role,
        expiresAt: tenantInvitationModel.expiresAt,
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
   * tenant-id order (the order the last-owner guard locks them in).
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
}
