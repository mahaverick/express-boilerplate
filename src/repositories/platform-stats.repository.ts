/**
 * @file Staff-only, cross-tenant aggregates for the Overview. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule); every
 * query leaves out the platform tenant and soft-deleted rows.
 */
import { and, count, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { EmailLogStatus } from '@/database/models/email-log.model'
import { emailLogModel } from '@/database/models/email-log.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * One UTC day, as `YYYY-MM-DD`, and how many rows fell in it.
 */
export interface DayCount {
  day: string
  count: number
}

/**
 * Live counts across the whole platform.
 */
export interface PlatformTotals {
  tenants: number
  users: number
  staff: number
}

/**
 * A timestamp's UTC day. `at time zone 'UTC'` makes the bucket independent of
 * the session's time zone.
 * @param column - A `timestamptz` column.
 * @returns The day as `YYYY-MM-DD` text.
 */
function utcDay(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`
}

/**
 * Query access for the platform Overview.
 */
export class PlatformStatsRepository {
  /**
   * Live customer tenants, live active users, and live platform staff. `staff` counts platform members regardless of `users.active`; only soft-deleted users are excluded.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The three totals.
   */
  async totals(executor: DbExecutor = db): Promise<PlatformTotals> {
    const [tenants] = await executor
      .select({ count: count() })
      .from(tenantModel)
      .where(and(isNull(tenantModel.deletedAt), eq(tenantModel.isPlatform, false)))
    const [users] = await executor
      .select({ count: count() })
      .from(userModel)
      .where(and(isNull(userModel.deletedAt), eq(userModel.active, true)))
    const [staff] = await executor
      .select({ count: count() })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
      .innerJoin(userModel, eq(userModel.id, userMembershipModel.userId))
      .where(and(eq(tenantModel.isPlatform, true), isNull(userModel.deletedAt)))
    return {
      tenants: tenants?.count ?? 0,
      users: users?.count ?? 0,
      staff: staff?.count ?? 0,
    }
  }

  /**
   * Users and customer tenants created per UTC day in `[from, to)`. Days with
   * none are absent; the service zero-fills them. Users are every non-deleted
   * user created that day, inactive and staff included; `totals()` counts
   * active users only.
   * @param from - Inclusive start, a UTC midnight.
   * @param to - Exclusive end, a UTC midnight.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns Per-day counts for each, in day order.
   */
  async signupsByDay(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<{ users: DayCount[]; tenants: DayCount[] }> {
    const userDay = utcDay(userModel.createdAt)
    const users = await executor
      .select({ day: userDay, count: count() })
      .from(userModel)
      .where(
        and(
          isNull(userModel.deletedAt),
          gte(userModel.createdAt, from),
          lt(userModel.createdAt, to)
        )
      )
      .groupBy(userDay)
      .orderBy(userDay)
    const tenantDay = utcDay(tenantModel.createdAt)
    const tenants = await executor
      .select({ day: tenantDay, count: count() })
      .from(tenantModel)
      .where(
        and(
          isNull(tenantModel.deletedAt),
          eq(tenantModel.isPlatform, false),
          gte(tenantModel.createdAt, from),
          lt(tenantModel.createdAt, to)
        )
      )
      .groupBy(tenantDay)
      .orderBy(tenantDay)
    return { users, tenants }
  }

  /**
   * Email delivery attempts logged per UTC day and status in `[from, to)`.
   * `email_logs` holds one row per attempt (up to five per mail), so a mail
   * retried after a failure and then sent counts once as failed and once as sent.
   * @param from - Inclusive start, a UTC midnight.
   * @param to - Exclusive end, a UTC midnight.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per day and status that has any.
   */
  async emailsByDay(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<{ day: string; status: EmailLogStatus; count: number }[]> {
    const day = utcDay(emailLogModel.createdAt)
    return executor
      .select({ day, status: emailLogModel.status, count: count() })
      .from(emailLogModel)
      .where(and(gte(emailLogModel.createdAt, from), lt(emailLogModel.createdAt, to)))
      .groupBy(day, emailLogModel.status)
      .orderBy(day)
  }
}
