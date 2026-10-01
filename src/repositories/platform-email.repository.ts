/**
 * @file Staff-only, cross-tenant reads of the email tracking tables: the
 * message search and detail, the health aggregates, the suppression list,
 * and the batched lookups `canResend` needs. Only
 * `services/platform-*.service.ts` may import this file (an eslint rule).
 * Keyset pages sort newest first on `(created_at, id)`; the cursor carries
 * `created_at` as UTC text that `::timestamptz` reads back exactly, and the
 * id breaks a tie, so rows sharing a `created_at` are never skipped at a
 * page boundary.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  BounceKind,
  EmailEventType,
  EmailMessageStatus,
  FailureOrigin,
  SenderClass,
  SuppressionReason,
} from '@/constants/email.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { EmailSuppressionStateFilter, PageDirection } from '@/constants/platform.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'
import { emailEventModel } from '@/database/models/email-event.model'
import { emailLogModel, type EmailLogStatus } from '@/database/models/email-log.model'
import { emailMessageModel } from '@/database/models/email-message.model'
import { emailSuppressionModel } from '@/database/models/email-suppression.model'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor } from '@/services/database.service'
import { escapeLikePattern } from '@/utilities/like-pattern.utilities'

/**
 * A row's sort key: its `created_at` as UTC text with microseconds, and its id.
 */
export interface EmailPageCursor {
  sortAt: string
  id: string
}

/**
 * The user a message or suppression names, as joined. `deletedAt` is set
 * for a soft-deleted user, who still has a detail page.
 */
export interface EmailUserRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  deletedAt: Date | null
}

/**
 * One `email_messages` row with its user and tenant joined (each null when
 * the message has none or the row was purged). Never the stored variables.
 */
export interface PlatformEmailRecord {
  id: string
  recipient: string
  templateKey: string
  status: EmailMessageStatus
  senderClass: SenderClass
  linkApp: FrontendApp | null
  failureOrigin: FailureOrigin | null
  userId: string | null
  tenantId: string | null
  invitationId: string | null
  resentFromId: string | null
  createdAt: Date
  statusUpdatedAt: Date
  user: EmailUserRow | null
  tenant: { id: string; name: string; slug: string } | null
}

/**
 * The search's inputs. `q` matches the recipient as a literal,
 * case-insensitive substring; `createdFrom` is inclusive and `createdBefore`
 * exclusive.
 */
export interface PlatformEmailSearchOptions {
  limit: number
  direction: PageDirection
  q?: string | undefined
  status?: EmailMessageStatus | undefined
  templateKey?: string | undefined
  tenantId?: string | undefined
  userId?: string | undefined
  createdFrom?: Date | undefined
  createdBefore?: Date | undefined
  cursor?: EmailPageCursor | undefined
}

/**
 * A page of rows and the cursors either side of it.
 */
export interface KeysetPage<TRow> {
  rows: TRow[]
  nextCursor?: EmailPageCursor
  prevCursor?: EmailPageCursor
}

/**
 * One send attempt of a message.
 */
export interface EmailAttemptRow {
  id: string
  status: EmailLogStatus
  errorCode: string | null
  createdAt: Date
}

/**
 * One provider event of a message.
 */
export interface EmailEventRow {
  id: string
  provider: string
  type: EmailEventType
  bounceKind: BounceKind | null
  detail: string | null
  occurredAt: Date
}

/**
 * An active suppression, as the message detail and `canResend` read it.
 */
export interface ActiveSuppressionRow {
  id: string
  address: string
  reason: SuppressionReason
  createdAt: Date
}

/**
 * An invitation as `canResend` reads it.
 */
export interface ResendInvitationRow {
  id: string
  tenantId: string
  role: MembershipRole
}

/**
 * One suppression with who lifted it and the message whose event caused it.
 */
export interface PlatformSuppressionRecord {
  id: string
  address: string
  reason: SuppressionReason
  sourceMessageId: string | null
  createdAt: Date
  liftedAt: Date | null
  liftReason: string | null
  liftedBy: EmailUserRow | null
}

/**
 * The suppression search's inputs.
 */
export interface PlatformSuppressionSearchOptions {
  limit: number
  direction: PageDirection
  state: EmailSuppressionStateFilter
  q?: string | undefined
  cursor?: EmailPageCursor | undefined
}

/**
 * Messages created on one UTC day in one status.
 */
export interface EmailStatusDayRow {
  day: string
  status: EmailMessageStatus
  count: number
}

/**
 * Messages from the `general` sender that left the server, and how many of
 * them have at least one opened and one clicked event.
 */
export interface EmailEngagementCounts {
  sent: number
  opened: number
  clicked: number
}

/**
 * Per-key counts for the health tables, over messages that were attempted
 * (`queued` and `suppressed` excluded).
 */
export interface EmailBreakdownCounts {
  key: string
  messages: number
  undelivered: number
  complained: number
}

/**
 * The statuses of a message that left this server: everything but `queued`
 * and `suppressed`.
 */
const LEFT_SERVER_STATUSES: readonly EmailMessageStatus[] = [
  'sent',
  'deferred',
  'delivered',
  'bounced',
  'failed',
  'complained',
]

/**
 * The statuses the health tables count as undelivered.
 */
const UNDELIVERED_STATUSES: readonly EmailMessageStatus[] = ['bounced', 'failed']

/**
 * A `timestamptz` column as UTC text with microseconds, the form a cursor
 * carries and `::timestamptz` reads back exactly.
 * @param column - The column.
 * @returns The text expression.
 */
function sortAtOf(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * A timestamp's UTC day, as `YYYY-MM-DD`.
 * @param column - A `timestamptz` column.
 * @returns The day as text.
 */
function utcDay(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`
}

/**
 * The keyset condition for a newest-first list: older rows for `next`,
 * newer ones for `prev`.
 * @param createdAt - The list's `created_at` column.
 * @param id - The list's `id` column.
 * @param cursor - The cursor.
 * @param isPrevious - Whether the page reads backwards.
 * @returns The condition.
 */
function cursorCondition(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: EmailPageCursor,
  isPrevious: boolean
): SQL {
  return isPrevious
    ? sql`(${createdAt}, ${id}) > (${cursor.sortAt}::timestamptz, ${cursor.id})`
    : sql`(${createdAt}, ${id}) < (${cursor.sortAt}::timestamptz, ${cursor.id})`
}

/**
 * The cursors either side of a page, rows already newest first. `prevCursor`
 * is absent on the first page; a page read from a cursor that comes back
 * empty hands that cursor back on the side it came from, so the client can
 * always step back.
 * @param rows - The page's rows, newest first.
 * @param hasMore - Whether a row beyond the page exists in the read direction.
 * @param direction - Which way the page was read.
 * @param cursor - The cursor it was read from, if any.
 * @returns The cursors to set.
 */
function pageCursors(
  rows: readonly { sortAt: string; id: string }[],
  hasMore: boolean,
  direction: PageDirection,
  cursor: EmailPageCursor | undefined
): Pick<KeysetPage<unknown>, 'nextCursor' | 'prevCursor'> {
  const first = rows[0]
  const last = rows.at(-1)
  const keyOf = (row: { sortAt: string; id: string }): EmailPageCursor => ({
    sortAt: row.sortAt,
    id: row.id,
  })
  if (direction === 'prev') {
    const next = last ? keyOf(last) : cursor
    return {
      ...(hasMore && first && { prevCursor: keyOf(first) }),
      ...(next && { nextCursor: next }),
    }
  }
  const previous = first ? keyOf(first) : cursor
  return {
    ...(hasMore && last && { nextCursor: keyOf(last) }),
    ...(cursor !== undefined && previous && { prevCursor: previous }),
  }
}

/**
 * A row without its sort key.
 * @param row - A selected row.
 * @param row.sortAt - Its sort key, dropped.
 * @returns The row, `sortAt` dropped.
 */
function withoutSortKey<TRow extends { sortAt: string }>({
  sortAt: _sortAt,
  ...row
}: TRow): Omit<TRow, 'sortAt'> {
  return row
}

/**
 * Trim the look-ahead row, put a backwards page newest first, and build its cursors.
 * @param rows - Up to `limit + 1` rows in read order.
 * @param limit - The page size.
 * @param direction - Which way the page was read.
 * @param cursor - The cursor it was read from, if any.
 * @returns The rows, newest first, and the cursors.
 */
function toPage<TRow extends { sortAt: string; id: string }>(
  rows: TRow[],
  limit: number,
  direction: PageDirection,
  cursor: EmailPageCursor | undefined
): KeysetPage<Omit<TRow, 'sortAt'>> {
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  if (direction === 'prev') rows.reverse()
  return {
    rows: rows.map((row) => withoutSortKey(row)),
    ...pageCursors(rows, hasMore, direction, cursor),
  }
}

/**
 * A left-joined user, or null when the join found none.
 * @param row - The joined columns, all null when no user matched.
 * @param row.id - The user's id.
 * @param row.email - Their address.
 * @param row.firstName - Their first name.
 * @param row.lastName - Their last name.
 * @param row.deletedAt - When they were soft-deleted.
 * @returns The user, or null.
 */
function userOrNull(row: {
  id: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  deletedAt: Date | null
}): EmailUserRow | null {
  if (row.id === null || row.email === null) {
    // eslint-disable-next-line unicorn/no-null -- no user row joined: purged, or the message had none
    return null
  }
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    deletedAt: row.deletedAt,
  }
}

const messageColumns = {
  id: emailMessageModel.id,
  recipient: emailMessageModel.recipient,
  templateKey: emailMessageModel.templateKey,
  status: emailMessageModel.status,
  senderClass: emailMessageModel.senderClass,
  linkApp: emailMessageModel.linkApp,
  failureOrigin: emailMessageModel.failureOrigin,
  userId: emailMessageModel.userId,
  tenantId: emailMessageModel.tenantId,
  invitationId: emailMessageModel.invitationId,
  resentFromId: emailMessageModel.resentFromId,
  createdAt: emailMessageModel.createdAt,
  statusUpdatedAt: emailMessageModel.statusUpdatedAt,
  sortAt: sortAtOf(emailMessageModel.createdAt),
  joinedUserId: userModel.id,
  joinedUserEmail: userModel.email,
  joinedUserFirstName: userModel.firstName,
  joinedUserLastName: userModel.lastName,
  joinedUserDeletedAt: userModel.deletedAt,
  joinedTenantId: tenantModel.id,
  joinedTenantName: tenantModel.name,
  joinedTenantSlug: tenantModel.slug,
}

/**
 * The message columns with the user and tenant left-joined, unfiltered.
 * @param executor - Where the query will run.
 * @returns The select, open for `where`, `orderBy` and `limit`.
 */
function selectMessages(executor: DbExecutor) {
  return executor
    .select(messageColumns)
    .from(emailMessageModel)
    .leftJoin(userModel, eq(userModel.id, emailMessageModel.userId))
    .leftJoin(tenantModel, eq(tenantModel.id, emailMessageModel.tenantId))
    .$dynamic()
}

/**
 * One selected message row, before the joins are folded into objects.
 */
type MessageSelection = Awaited<ReturnType<typeof selectMessages>>[number]

/**
 * Fold a selected message row's join columns into `user` and `tenant`.
 * @param row - The selected row.
 * @returns The record and its sort key.
 */
function toRecord(row: MessageSelection): PlatformEmailRecord & { sortAt: string } {
  const {
    joinedUserId,
    joinedUserEmail,
    joinedUserFirstName,
    joinedUserLastName,
    joinedUserDeletedAt,
    joinedTenantId,
    joinedTenantName,
    joinedTenantSlug,
    ...message
  } = row
  return {
    ...message,
    user: userOrNull({
      id: joinedUserId,
      email: joinedUserEmail,
      firstName: joinedUserFirstName,
      lastName: joinedUserLastName,
      deletedAt: joinedUserDeletedAt,
    }),
    tenant:
      joinedTenantId !== null && joinedTenantName !== null && joinedTenantSlug !== null
        ? { id: joinedTenantId, name: joinedTenantName, slug: joinedTenantSlug }
        : // eslint-disable-next-line unicorn/no-null -- no tenant row joined: purged, or the message had none
          null,
  }
}

/**
 * The search's filters, before the cursor.
 * @param options - The search's inputs.
 * @returns The conditions to AND together.
 */
function messageFilters(options: PlatformEmailSearchOptions): SQL[] {
  const conditions: SQL[] = []
  if (options.q !== undefined) {
    const pattern = `%${escapeLikePattern(options.q)}%`
    conditions.push(sql`lower(${emailMessageModel.recipient}) like lower(${pattern}) escape '\\'`)
  }
  if (options.status !== undefined) conditions.push(eq(emailMessageModel.status, options.status))
  if (options.templateKey !== undefined) {
    conditions.push(eq(emailMessageModel.templateKey, options.templateKey))
  }
  if (options.tenantId !== undefined) {
    conditions.push(eq(emailMessageModel.tenantId, options.tenantId))
  }
  if (options.userId !== undefined) conditions.push(eq(emailMessageModel.userId, options.userId))
  if (options.createdFrom !== undefined) {
    conditions.push(gte(emailMessageModel.createdAt, options.createdFrom))
  }
  if (options.createdBefore !== undefined) {
    conditions.push(lt(emailMessageModel.createdAt, options.createdBefore))
  }
  return conditions
}

/**
 * Messages created in `[from, to)` that left this server.
 * @param from - Inclusive start.
 * @param to - Exclusive end.
 * @returns The condition.
 */
function leftServerIn(from: Date, to: Date): SQL | undefined {
  return and(
    gte(emailMessageModel.createdAt, from),
    lt(emailMessageModel.createdAt, to),
    inArray(emailMessageModel.status, [...LEFT_SERVER_STATUSES])
  )
}

/**
 * Query access for the staff email pages.
 */
export class PlatformEmailRepository {
  /**
   * A page of messages, newest first, keyset on `(created_at, id)`.
   * @param options - Filters, page size, direction and cursor.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page and its cursors.
   */
  async search(
    options: PlatformEmailSearchOptions,
    executor: DbExecutor = db
  ): Promise<KeysetPage<PlatformEmailRecord>> {
    const isPrevious = options.direction === 'prev'
    const conditions = messageFilters(options)
    if (options.cursor !== undefined) {
      conditions.push(
        cursorCondition(
          emailMessageModel.createdAt,
          emailMessageModel.id,
          options.cursor,
          isPrevious
        )
      )
    }
    const rows = await selectMessages(executor)
      .where(and(...conditions))
      .orderBy(
        ...(isPrevious
          ? [asc(emailMessageModel.createdAt), asc(emailMessageModel.id)]
          : [desc(emailMessageModel.createdAt), desc(emailMessageModel.id)])
      )
      .limit(options.limit + 1)
    return toPage(
      rows.map((row) => toRecord(row)),
      options.limit,
      options.direction,
      options.cursor
    )
  }

  /**
   * One message with its user and tenant.
   * @param id - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The record, or undefined when no message has that id.
   */
  async findRecord(
    id: string,
    executor: DbExecutor = db
  ): Promise<PlatformEmailRecord | undefined> {
    const [row] = await selectMessages(executor).where(eq(emailMessageModel.id, id)).limit(1)
    return row === undefined ? undefined : withoutSortKey(toRecord(row))
  }

  /**
   * The stored preview variables of one message: only the template's
   * non-secret `previewVariables` are ever written there.
   * @param id - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The variables, or undefined when no message has that id.
   */
  async findVariables(
    id: string,
    executor: DbExecutor = db
  ): Promise<Record<string, unknown> | undefined> {
    const [row] = await executor
      .select({ variables: emailMessageModel.variables })
      .from(emailMessageModel)
      .where(eq(emailMessageModel.id, id))
      .limit(1)
    return row?.variables
  }

  /**
   * A message's send attempts, oldest first.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The attempts.
   */
  async listAttempts(messageId: string, executor: DbExecutor = db): Promise<EmailAttemptRow[]> {
    return executor
      .select({
        id: emailLogModel.id,
        status: emailLogModel.status,
        errorCode: emailLogModel.errorCode,
        createdAt: emailLogModel.createdAt,
      })
      .from(emailLogModel)
      .where(eq(emailLogModel.messageId, messageId))
      .orderBy(asc(emailLogModel.createdAt), asc(emailLogModel.id))
  }

  /**
   * A message's provider events, in the order they occurred.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The events.
   */
  async listEvents(messageId: string, executor: DbExecutor = db): Promise<EmailEventRow[]> {
    return executor
      .select({
        id: emailEventModel.id,
        provider: emailEventModel.provider,
        type: emailEventModel.type,
        bounceKind: emailEventModel.bounceKind,
        detail: emailEventModel.detail,
        occurredAt: emailEventModel.occurredAt,
      })
      .from(emailEventModel)
      .where(eq(emailEventModel.messageId, messageId))
      .orderBy(asc(emailEventModel.occurredAt), asc(emailEventModel.id))
  }

  /**
   * The ids of the messages resent from this one, oldest first.
   * @param messageId - The message id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The ids.
   */
  async listResentAsIds(messageId: string, executor: DbExecutor = db): Promise<string[]> {
    const rows = await executor
      .select({ id: emailMessageModel.id })
      .from(emailMessageModel)
      .where(eq(emailMessageModel.resentFromId, messageId))
      .orderBy(asc(emailMessageModel.createdAt), asc(emailMessageModel.id))
    return rows.map((row) => row.id)
  }

  /**
   * The active suppressions among some addresses, matched case-insensitively.
   * @param addresses - The addresses, in any case.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One entry per suppressed address, keyed by the lowercased address.
   */
  async activeSuppressionsFor(
    addresses: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, ActiveSuppressionRow>> {
    const lowered = [...new Set(addresses.map((address) => address.toLowerCase()))]
    if (lowered.length === 0) return new Map()
    const rows = await executor
      .select({
        id: emailSuppressionModel.id,
        address: emailSuppressionModel.address,
        reason: emailSuppressionModel.reason,
        createdAt: emailSuppressionModel.createdAt,
      })
      .from(emailSuppressionModel)
      .where(
        and(inArray(emailSuppressionModel.address, lowered), isNull(emailSuppressionModel.liftedAt))
      )
    return new Map(rows.map((row) => [row.address, row]))
  }

  /**
   * The platform roles of some users.
   * @param userIds - The users.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Each staff user's platform role; users without one are absent.
   */
  async platformRolesOf(
    userIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, MembershipRole>> {
    if (userIds.length === 0) return new Map()
    const rows = await executor
      .select({ userId: userMembershipModel.userId, role: userMembershipModel.role })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(tenantModel.id, userMembershipModel.tenantId))
      .where(
        and(eq(tenantModel.isPlatform, true), inArray(userMembershipModel.userId, [...userIds]))
      )
    return new Map(rows.map((row) => [row.userId, row.role]))
  }

  /**
   * One user's membership roles in some tenants.
   * @param userId - The user.
   * @param tenantIds - The tenants.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The role per tenant the user is a member of; other tenants are absent.
   */
  async membershipRolesIn(
    userId: string,
    tenantIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, MembershipRole>> {
    if (tenantIds.length === 0) return new Map()
    const rows = await executor
      .select({ tenantId: userMembershipModel.tenantId, role: userMembershipModel.role })
      .from(userMembershipModel)
      .where(
        and(
          eq(userMembershipModel.userId, userId),
          inArray(userMembershipModel.tenantId, [...tenantIds])
        )
      )
    return new Map(rows.map((row) => [row.tenantId, row.role]))
  }

  /**
   * Some invitations' tenants and roles, whatever their state.
   * @param invitationIds - The invitations.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Each invitation that still exists, keyed by id.
   */
  async invitationsById(
    invitationIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, ResendInvitationRow>> {
    if (invitationIds.length === 0) return new Map()
    const rows = await executor
      .select({
        id: tenantInvitationModel.id,
        tenantId: tenantInvitationModel.tenantId,
        role: tenantInvitationModel.role,
      })
      .from(tenantInvitationModel)
      .where(inArray(tenantInvitationModel.id, [...invitationIds]))
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * A tenant's lifecycle state and platform flag, soft-deleted tenants included.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The state and flag, or undefined when the tenant is gone.
   */
  async tenantState(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<{ lifecycleState: TenantLifecycleState; isPlatform: boolean } | undefined> {
    const [row] = await executor
      .select({ lifecycleState: tenantModel.lifecycleState, isPlatform: tenantModel.isPlatform })
      .from(tenantModel)
      .where(eq(tenantModel.id, tenantId))
      .limit(1)
    return row
  }

  /**
   * Messages created per UTC day and status in `[from, to)`.
   * @param from - Inclusive start, a UTC midnight.
   * @param to - Exclusive end, a UTC midnight.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per day and status that has any.
   */
  async statusCountsByDay(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<EmailStatusDayRow[]> {
    const day = utcDay(emailMessageModel.createdAt)
    return executor
      .select({ day, status: emailMessageModel.status, count: count() })
      .from(emailMessageModel)
      .where(and(gte(emailMessageModel.createdAt, from), lt(emailMessageModel.createdAt, to)))
      .groupBy(day, emailMessageModel.status)
      .orderBy(day)
  }

  /**
   * Provider events received in `[from, to)`, whatever message they belong to.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async providerEventCount(from: Date, to: Date, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
      .select({ count: count() })
      .from(emailEventModel)
      .where(and(gte(emailEventModel.receivedAt, from), lt(emailEventModel.receivedAt, to)))
    return row?.count ?? 0
  }

  /**
   * Open and click counts over `general`-sender messages created in
   * `[from, to)` that left this server. Token emails go through the
   * transactional sender, whose tracking stays off, so they are left out of
   * both sides of the rate.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The denominator and both numerators.
   */
  async engagement(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<EmailEngagementCounts> {
    // A builder subquery, not raw SQL: drizzle leaves a single-table query's own columns unqualified, which would bind this message id to the event's.
    const withEvent = (type: EmailEventType): SQL<number> => {
      const event = executor
        .select({ id: emailEventModel.id })
        .from(emailEventModel)
        .where(
          and(eq(emailEventModel.messageId, emailMessageModel.id), eq(emailEventModel.type, type))
        )
      return sql<number>`count(*) filter (where ${exists(event)})`.mapWith(Number)
    }
    const [row] = await executor
      .select({ sent: count(), opened: withEvent('opened'), clicked: withEvent('clicked') })
      .from(emailMessageModel)
      .where(and(leftServerIn(from, to), eq(emailMessageModel.senderClass, 'general')))
    return { sent: row?.sent ?? 0, opened: row?.opened ?? 0, clicked: row?.clicked ?? 0 }
  }

  /**
   * Messages created in `[from, to)` that left this server, grouped by
   * template or by lowercased recipient domain, most messages first.
   * @param by - Group by `template` or `domain`.
   * @param from - Inclusive start.
   * @param to - Exclusive end.
   * @param limit - The most groups returned.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One row per group.
   */
  async breakdown(
    by: 'template' | 'domain',
    from: Date,
    to: Date,
    limit: number,
    executor: DbExecutor = db
  ): Promise<EmailBreakdownCounts[]> {
    const key =
      by === 'template'
        ? sql<string>`${emailMessageModel.templateKey}`
        : sql<string>`lower(split_part(${emailMessageModel.recipient}, '@', 2))`
    const undelivered =
      sql<number>`count(*) filter (where ${inArray(emailMessageModel.status, [...UNDELIVERED_STATUSES])})`.mapWith(
        Number
      )
    const complained =
      sql<number>`count(*) filter (where ${eq(emailMessageModel.status, 'complained')})`.mapWith(
        Number
      )
    return executor
      .select({ key, messages: count(), undelivered, complained })
      .from(emailMessageModel)
      .where(leftServerIn(from, to))
      .groupBy(key)
      .orderBy(desc(count()), asc(key))
      .limit(limit)
  }

  /**
   * A page of suppressions, newest first, keyset on `(created_at, id)`.
   * @param options - State, `q` (address substring), page size, direction and cursor.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page and its cursors.
   */
  async searchSuppressions(
    options: PlatformSuppressionSearchOptions,
    executor: DbExecutor = db
  ): Promise<KeysetPage<PlatformSuppressionRecord>> {
    const isPrevious = options.direction === 'prev'
    const conditions: SQL[] = []
    if (options.state === 'active') {
      conditions.push(isNull(emailSuppressionModel.liftedAt))
    } else if (options.state === 'lifted') {
      conditions.push(isNotNull(emailSuppressionModel.liftedAt))
    }
    if (options.q !== undefined) {
      const pattern = `%${escapeLikePattern(options.q)}%`
      conditions.push(sql`${emailSuppressionModel.address} like lower(${pattern}) escape '\\'`)
    }
    if (options.cursor !== undefined) {
      conditions.push(
        cursorCondition(
          emailSuppressionModel.createdAt,
          emailSuppressionModel.id,
          options.cursor,
          isPrevious
        )
      )
    }
    const rows = await selectSuppressions(executor)
      .where(and(...conditions))
      .orderBy(
        ...(isPrevious
          ? [asc(emailSuppressionModel.createdAt), asc(emailSuppressionModel.id)]
          : [desc(emailSuppressionModel.createdAt), desc(emailSuppressionModel.id)])
      )
      .limit(options.limit + 1)
    return toPage(
      rows.map((row) => toSuppressionRecord(row)),
      options.limit,
      options.direction,
      options.cursor
    )
  }

  /**
   * One suppression, lifted or not.
   * @param id - The suppression id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The record, or undefined when no suppression has that id.
   */
  async findSuppression(
    id: string,
    executor: DbExecutor = db
  ): Promise<PlatformSuppressionRecord | undefined> {
    const [row] = await selectSuppressions(executor)
      .where(eq(emailSuppressionModel.id, id))
      .limit(1)
    return row === undefined ? undefined : withoutSortKey(toSuppressionRecord(row))
  }
}

/**
 * The suppression columns, with the lifter and the source event's message
 * left-joined, unfiltered.
 * @param executor - Where the query will run.
 * @returns The select, open for `where`, `orderBy` and `limit`.
 */
function selectSuppressions(executor: DbExecutor) {
  return executor
    .select({
      id: emailSuppressionModel.id,
      address: emailSuppressionModel.address,
      reason: emailSuppressionModel.reason,
      sourceMessageId: emailEventModel.messageId,
      createdAt: emailSuppressionModel.createdAt,
      liftedAt: emailSuppressionModel.liftedAt,
      liftReason: emailSuppressionModel.liftReason,
      sortAt: sortAtOf(emailSuppressionModel.createdAt),
      lifterId: userModel.id,
      lifterEmail: userModel.email,
      lifterFirstName: userModel.firstName,
      lifterLastName: userModel.lastName,
      lifterDeletedAt: userModel.deletedAt,
    })
    .from(emailSuppressionModel)
    .leftJoin(emailEventModel, eq(emailEventModel.id, emailSuppressionModel.sourceEventId))
    .leftJoin(userModel, eq(userModel.id, emailSuppressionModel.liftedBy))
    .$dynamic()
}

/**
 * Fold a selected suppression row's lifter columns into `liftedBy`.
 * @param row - The selected row.
 * @returns The record and its sort key.
 */
function toSuppressionRecord(
  row: Awaited<ReturnType<typeof selectSuppressions>>[number]
): PlatformSuppressionRecord & { sortAt: string } {
  const { lifterId, lifterEmail, lifterFirstName, lifterLastName, lifterDeletedAt, ...rest } = row
  return {
    ...rest,
    liftedBy: userOrNull({
      id: lifterId,
      email: lifterEmail,
      firstName: lifterFirstName,
      lastName: lifterLastName,
      deletedAt: lifterDeletedAt,
    }),
  }
}
