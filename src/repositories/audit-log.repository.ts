/**
 * @file Insert, list, the retention purge's batch delete, and a staff purge's
 * redaction and tenant delete for `audit_logs`. The table's trigger rejects
 * every UPDATE except that redaction, inside a transaction a staff purge
 * (platform-purge.service.ts) opened for it, and every DELETE outside a
 * transaction the retention purge (retention.service.ts) or a tenant purge
 * opened for it.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { AuditAccess, StoredAuditAction } from '@/constants/audit.constants'
import { auditLogModel, type AuditLog, type NewAuditLog } from '@/database/models/audit-log.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import {
  defineList,
  listPage,
  searchCondition,
  timestampKey,
  timestampSort,
  type ListPage,
  type ListParams,
} from '@/utilities/list-page.utilities'

/**
 * The actor's public identity.
 */
interface AuditActorRow {
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
 * The actor columns an entry lists with: an explicit projection, never the full row.
 */
const actorColumns = {
  id: userModel.id,
  email: userModel.email,
  firstName: userModel.firstName,
  lastName: userModel.lastName,
}

/**
 * The audit list's filters. A tenant read always sets `tenantId`.
 */
export interface AuditLogFilters {
  tenantId?: string | undefined
  actorUserId?: string | undefined
  targetId?: string | undefined
  actions?: StoredAuditAction[] | undefined
  access?: AuditAccess[] | undefined
  /**
  Which read this is. A `tenant` read is of one tenant's own log: search then matches only the entry's own tenant as a target and never a user target's email, since the entry can name a target outside the tenant (a staff action filed under it). A `platform` read searches every target. Required, so a new caller must choose.
   */
  scope: 'tenant' | 'platform'
}

/**
 * The user a `user` target names, joined for search.
 */
const targetUser = alias(userModel, 'target_user')

/**
 * The tenant a `tenant` target names, joined for search.
 */
const targetTenant = alias(tenantModel, 'target_tenant')

/**
 * The audit list, newest first by default. The actor and the target are
 * left joins, so an entry whose actor or target has no row still lists;
 * `search` matches the action, the actor's email, a user target's email and
 * a tenant target's name; a tenant read (`scope: 'tenant'`) matches the
 * entry's own tenant as a target only and skips user targets. Its cursors
 * are bound to the tenant.
 * @param search - The parsed search, or undefined.
 * @param filters - The filters.
 * @returns The list definition.
 */
export function auditLogList(search: string | undefined, filters: AuditLogFilters) {
  return defineList({
    name: filters.scope === 'tenant' ? 'tenant-audit-log' : 'platform-audit-log',
    base: (executor, seek) =>
      executor
        .select({
          id: auditLogModel.id,
          entry: auditLogModel,
          actor: actorColumns,
          tenant: { id: tenantModel.id, name: tenantModel.name, slug: tenantModel.slug },
          sortOccurred: timestampKey(auditLogModel.occurredAt),
        })
        .from(auditLogModel)
        .innerJoin(tenantModel, eq(auditLogModel.tenantId, tenantModel.id))
        .leftJoin(userModel, eq(auditLogModel.actorUserId, userModel.id))
        .leftJoin(
          targetUser,
          and(eq(auditLogModel.targetType, 'user'), eq(targetUser.id, auditLogModel.targetId))
        )
        .leftJoin(
          targetTenant,
          and(
            eq(auditLogModel.targetType, 'tenant'),
            eq(targetTenant.id, auditLogModel.targetId),
            filters.scope === 'tenant' ? eq(targetTenant.id, auditLogModel.tenantId) : undefined
          )
        )
        .where(
          and(
            filters.tenantId === undefined
              ? undefined
              : eq(auditLogModel.tenantId, filters.tenantId),
            filters.targetId === undefined
              ? undefined
              : eq(auditLogModel.targetId, filters.targetId),
            filters.actorUserId === undefined
              ? undefined
              : eq(auditLogModel.actorUserId, filters.actorUserId),
            filters.actions === undefined
              ? undefined
              : inArray(auditLogModel.action, filters.actions),
            filters.access === undefined
              ? undefined
              : inArray(auditLogModel.access, filters.access),
            searchCondition(search, [
              // Lowercase already: its CHECK allows only `[a-z._]`.
              sql`${auditLogModel.action}`,
              sql`lower(${userModel.email})`,
              ...(filters.scope === 'tenant' ? [] : [sql`lower(${targetUser.email})`]),
              sql`lower(${targetTenant.name})`,
            ]),
            seek
          )
        )
        .$dynamic(),
    id: auditLogModel.id,
    sorts: {
      '-occurred': [timestampSort(auditLogModel.occurredAt, 'desc', 'sortOccurred')],
      occurred: [timestampSort(auditLogModel.occurredAt, 'asc', 'sortOccurred')],
    },
    ...(filters.tenantId !== undefined && { bound: { tenantId: filters.tenantId } }),
    toItem: ({ id: _id, sortOccurred: _occurred, ...row }): AuditLogListRow => row,
  })
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
   * One page of entries, newest first unless asked otherwise.
   * @param params - The parsed shared list params.
   * @param filters - The tenant, actor, target, actions and access paths.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The page.
   * @throws {InvalidCursorError} When the cursor does not verify.
   */
  async list(
    params: ListParams,
    filters: AuditLogFilters,
    executor: DbExecutor = db
  ): Promise<ListPage<AuditLogListRow>> {
    return listPage(executor, auditLogList(params.search, filters), params)
  }

  /**
   * Delete at most `limit` entries that occurred before `cutoff`. The trigger
   * refuses this unless `tx` is a retention purge transaction; see
   * retention.service.ts.
   * Takes the batch oldest id first with FOR UPDATE SKIP LOCKED: a row a
   * request holds is left for a later run instead of waited on, so a batch
   * can come back short while matching rows remain.
   * The ids are collected with `= any(array(...))`, which runs the locking
   * subquery once, so the delete takes at most `limit` rows (see
   * `AnalyticsOutboxRepository.claimBatch`).
   * @param cutoff - Entries older than this go.
   * @param limit - The most rows to delete in this call.
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
    const result = await tx
      .delete(auditLogModel)
      .where(sql`${auditLogModel.id} = any(array(${batch}))`)
    return result.count
  }

  /**
   * Erase a person from the entries they acted in: `actor_user_id`, `ip`
   * and `user_agent` become NULL; the action, target and time stay. The
   * trigger allows this UPDATE only inside a staff purge's transaction, which
   * sets the redact setting first (platform-purge.service.ts).
   * @param userId - The actor being erased.
   * @param tx - The purge's transaction.
   * @returns How many entries were redacted.
   */
  async redactActor(userId: string, tx: DbTransaction): Promise<number> {
    const result = await tx
      .update(auditLogModel)
      .set({ actorUserId: null, ip: null, userAgent: null })
      .where(eq(auditLogModel.actorUserId, userId))
    return result.count
  }

  /**
   * Delete every entry filed under one tenant, for a tenant purge. The
   * trigger allows it only inside the purge settings
   * (platform-purge.service.ts).
   * @param tenantId - The tenant being purged.
   * @param tx - The purge's transaction.
   * @returns How many entries were deleted.
   */
  async deleteForTenant(tenantId: string, tx: DbTransaction): Promise<number> {
    const result = await tx.delete(auditLogModel).where(eq(auditLogModel.tenantId, tenantId))
    return result.count
  }
}
