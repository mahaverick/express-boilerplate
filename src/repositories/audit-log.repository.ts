// src/repositories/audit-log.repository.ts
//
// Insert, list, and the retention purge's batch delete. audit_logs'
// trigger rejects every UPDATE, and every DELETE outside a transaction the
// retention purge has opened for it (retention.service.ts). This class
// issues no UPDATE.
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { AuditAccess, AuditAction } from '@/constants/audit.constants'
import { auditLogModel, type AuditLog, type NewAuditLog } from '@/database/models/audit-log.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

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
export interface AuditLogRepositoryPage {
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
function toPage(rows: AuditLogListRow[], limit: number): AuditLogRepositoryPage {
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
  async list(
    options: AuditLogListOptions,
    executor: DbExecutor = db
  ): Promise<AuditLogRepositoryPage> {
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

  /**
   * Delete up to `limit` entries that occurred before `cutoff`. The trigger
   * refuses this unless `tx` is a retention purge transaction; see
   * retention.service.ts.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * @param cutoff - Entries older than this go.
   * @param limit - The most rows one call deletes.
   * @param tx - The purge's batch transaction.
   * @returns How many rows were deleted.
   */
  async purgeOccurredBefore(cutoff: Date, limit: number, tx: DbTransaction): Promise<number> {
    const batch = tx
      .select({ id: auditLogModel.id })
      .from(auditLogModel)
      .where(sql`${auditLogModel.occurredAt} < ${cutoff.toISOString()}::timestamptz`)
      .orderBy(auditLogModel.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    const result = await tx.delete(auditLogModel).where(inArray(auditLogModel.id, batch))
    return result.count
  }
}
