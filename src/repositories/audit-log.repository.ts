// src/repositories/audit-log.repository.ts
//
// Insert and list only: `audit_logs` is append-only, and its trigger rejects
// any UPDATE or DELETE, so this class has no method that could issue one.
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { AuditAccess, AuditAction } from '@/constants/audit.constants'
import { auditLogModel, type AuditLog, type NewAuditLog } from '@/database/models/audit-log.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * The last row of a page: where the next page resumes, newest first.
 */
export interface AuditLogCursor {
  occurredAt: Date
  id: string
}

/**
 * The actor's public identity, never `passwordHash`.
 */
export interface AuditActorRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * One entry with its actor (null when no user row joined) and its tenant.
 */
export interface AuditLogListRow {
  entry: AuditLog
  actor: AuditActorRow | null
  tenant: { id: string; name: string; slug: string }
}

/**
 * Paging and the optional filters. A tenant read always sets `tenantId`.
 */
export interface AuditLogListOptions {
  limit: number
  cursor?: AuditLogCursor | undefined
  tenantId?: string | undefined
  actorUserId?: string | undefined
  action?: AuditAction | undefined
  access?: AuditAccess | undefined
}

/**
 * A page of rows and, when more remain, the cursor for the next one.
 */
export interface AuditLogPage {
  rows: AuditLogListRow[]
  nextCursor?: AuditLogCursor
}

const actorColumns = {
  id: userModel.id,
  email: userModel.email,
  firstName: userModel.firstName,
  lastName: userModel.lastName,
}

/**
 * The filter and keyset conditions for one listing.
 * @param options - The listing's filters and cursor.
 * @returns The conditions to AND together.
 */
function conditionsFor(options: AuditLogListOptions): SQL[] {
  const conditions: SQL[] = []
  if (options.tenantId !== undefined) {
    conditions.push(eq(auditLogModel.tenantId, options.tenantId))
  }
  if (options.actorUserId !== undefined) {
    conditions.push(eq(auditLogModel.actorUserId, options.actorUserId))
  }
  if (options.action !== undefined) conditions.push(eq(auditLogModel.action, options.action))
  if (options.access !== undefined) conditions.push(eq(auditLogModel.access, options.access))
  if (options.cursor !== undefined) {
    // An ISO string cast back, not a bare Date: postgres.js cannot bind a Date inside a raw `sql` fragment.
    conditions.push(
      sql`(${auditLogModel.occurredAt}, ${auditLogModel.id}) < (${options.cursor.occurredAt.toISOString()}::timestamptz, ${options.cursor.id})`
    )
  }
  return conditions
}

/**
 * Trim the look-ahead row and build the next cursor from the last row kept.
 * @param rows - Up to `limit + 1` rows, newest first.
 * @param limit - The page size.
 * @returns The page.
 */
function toPage(rows: AuditLogListRow[], limit: number): AuditLogPage {
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  const last = rows.at(-1)
  if (hasMore && last !== undefined) {
    return { rows, nextCursor: { occurredAt: last.entry.occurredAt, id: last.entry.id } }
  }
  return { rows }
}

/**
 * Query access to `audit_logs`: append one entry, and page through one
 * tenant's log or every tenant's, newest first.
 */
export class AuditLogRepository {
  /**
   * Append one entry.
   * @param values - The entry's columns.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row.
   */
  async insert(values: NewAuditLog, executor: DbExecutor = db): Promise<AuditLog> {
    const [row] = await executor.insert(auditLogModel).values(values).returning()
    if (row === undefined) throw new HttpError('Insert returned no row', 500)
    return row
  }

  /**
   * A page of entries, newest first, keyset on `(occurredAt, id)`. The actor
   * is a left join, so an entry whose actor has no user row still lists.
   * @param options - Page size, cursor, and the optional tenant, actor, action and access filters.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The page, with `nextCursor` only when more rows remain.
   */
  async list(options: AuditLogListOptions, executor: DbExecutor = db): Promise<AuditLogPage> {
    const rows = await executor
      .select({
        entry: auditLogModel,
        actor: actorColumns,
        tenant: { id: tenantModel.id, name: tenantModel.name, slug: tenantModel.slug },
      })
      .from(auditLogModel)
      .innerJoin(tenantModel, eq(auditLogModel.tenantId, tenantModel.id))
      .leftJoin(userModel, eq(auditLogModel.actorUserId, userModel.id))
      .where(and(...conditionsFor(options)))
      .orderBy(desc(auditLogModel.occurredAt), desc(auditLogModel.id))
      .limit(options.limit + 1)
    return toPage(rows, options.limit)
  }
}
