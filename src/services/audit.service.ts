/**
 * @file The one writer and reader of `audit_logs`. `record` validates an entry's
 * metadata against its action's strict schema and throws on a mismatch, so a bad
 * entry fails its caller's transaction instead of being dropped.
 */
import {
  AUDIT_ACTIONS,
  PLATFORM_ACCESS_DEDUPE_SECONDS,
  type AuditAccess,
  type AuditAction,
  type AuditMetadata,
} from '@/constants/audit.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { AuditLog } from '@/database/models/audit-log.model'
import {
  AuditLogRepository,
  type AuditLogListOptions,
  type AuditLogListRow,
} from '@/repositories/audit-log.repository'
import { enqueueAuditAnalytics } from '@/services/analytics/analytics-outbox.service'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { waitForRedisWrite, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requestContextStore } from '@/services/request-context.service'
import type { Actor } from '@/types/actor'
import type { TimelineKind } from '@/types/timeline'
import { encodeCursor } from '@/utilities/cursor.utilities'
import type { PlatformAuditLogQuery, TenantAuditLogQuery } from '@/validators/audit.validators'

const auditLogRepository = new AuditLogRepository()

const MAX_REQUEST_ID_LENGTH = 64
const MAX_IP_LENGTH = 45
const MAX_USER_AGENT_LENGTH = 512

/**
 * One entry for `record`, typed so each action carries its own metadata shape.
 */
export type AuditEntry = {
  [TAction in AuditAction]: {
    action: TAction
    /**
     * The signed-in user who acted, or `'system'` for a script.
     */
    actor: Actor | 'system'
    access: AuditAccess
    tenantId: string
    targetId: string
    metadata: AuditMetadata<TAction>
  }
}[AuditAction]

/**
 * Validate an entry and insert it, with request metadata from the ALS, then
 * forward it to the analytics outbox (`enqueueAuditAnalytics`), which never
 * throws and, inside a transaction, writes in a savepoint of its own. The
 * request id, IP and user agent are cut to their column widths in
 * audit-log.model.ts.
 * @param entry - The entry to validate and insert.
 * @param executor - Where to insert.
 * @returns The inserted row.
 * @throws {Error} When the metadata does not match the action's schema.
 */
async function writeEntry(entry: AuditEntry, executor: DbExecutor): Promise<AuditLog> {
  const definition = AUDIT_ACTIONS[entry.action]
  const parsed = definition.metadata.safeParse(entry.metadata)
  if (!parsed.success) {
    // Paths and issue codes only: the rejected values may be the very data that must not be logged.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.code}`)
      .join('; ')
    throw new Error(`Invalid audit metadata for ${entry.action}: ${issues}`)
  }
  const context = requestContextStore.getStore()
  const inserted = await auditLogRepository.insert(
    {
      actorKind: entry.actor === 'system' ? 'system' : 'user',
      actorUserId: entry.actor === 'system' ? undefined : entry.actor.userId,
      access: entry.access,
      tenantId: entry.tenantId,
      action: entry.action,
      targetType: definition.target,
      targetId: entry.targetId,
      metadata: parsed.data,
      requestId: context?.requestId.slice(0, MAX_REQUEST_ID_LENGTH),
      ip: context?.ip?.slice(0, MAX_IP_LENGTH),
      userAgent: context?.userAgent?.slice(0, MAX_USER_AGENT_LENGTH),
    },
    executor
  )
  await enqueueAuditAnalytics(inserted, executor)
  return inserted
}

/**
 * Append an audit entry inside the caller's transaction, so it commits or
 * rolls back with the change it records.
 * @param entry - The action, actor, access, tenant, target and metadata.
 * @param tx - The transaction making the audited change.
 * @returns The inserted row.
 * @throws {Error} When the metadata does not match the action's strict schema.
 */
export async function record(entry: AuditEntry, tx: DbTransaction): Promise<AuditLog> {
  return writeEntry(entry, tx)
}

/**
 * Record a staff visit to a tenant at most once per hour per user and
 * tenant. A Redis failure skips the dedupe, never the write.
 * @param actor - The staff user.
 * @param tenantId - The tenant they opened.
 * @param platformRole - Their platform role, the access they used.
 * @returns The written row, or undefined when this visit was already recorded this hour.
 * @throws {Error} When the metadata does not match the action's schema or the insert
 * fails; a key this call claimed is released first.
 */
export async function recordPlatformAccess(
  actor: Actor,
  tenantId: string,
  platformRole: MembershipRole
): Promise<AuditLog | undefined> {
  const key = redisKey('audit', 'platform-access', actor.userId, tenantId)
  let hasClaimedKey = false
  try {
    const reply = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.set(key, '1', {
        condition: 'NX',
        expiration: { type: 'EX', value: PLATFORM_ACCESS_DEDUPE_SECONDS },
      })
    }, 'platform access dedupe')
    if (reply === null) return undefined
    hasClaimedKey = true
  } catch (error) {
    logger.warn('Platform access dedupe unavailable; writing the audit entry anyway', { error })
  }

  try {
    return await writeEntry(
      {
        action: 'tenant.accessed_by_platform',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { platformRole },
      },
      db
    )
  } catch (error) {
    // Release the key so the next visit retries instead of going unrecorded for an hour.
    if (hasClaimedKey) await releaseDedupeKey(key)
    throw error
  }
}

/**
 * Record that a staff member read a user's or a tenant's timeline:
 * `user.timeline_viewed` or `tenant.timeline_viewed`, written on the pool in
 * the platform tenant, outside any transaction, since a timeline read
 * changes nothing to commit with. It always writes; the caller
 * (platform-timeline.service.ts) decides how often to call it.
 * @param actor - The staff member.
 * @param platformTenantId - The platform tenant, where the entry is written.
 * @param kind - Whose timeline.
 * @param targetId - The user or tenant id.
 * @param metadata - The range and view they read it with.
 * @returns The written row.
 * @throws {Error} When the metadata does not match the schema or the insert fails.
 */
export async function recordTimelineView(
  actor: Actor,
  platformTenantId: string,
  kind: TimelineKind,
  targetId: string,
  metadata: AuditMetadata<'user.timeline_viewed'>
): Promise<AuditLog> {
  const common = {
    actor,
    access: 'platform',
    tenantId: platformTenantId,
    targetId,
    metadata,
  } as const
  return writeEntry(
    kind === 'user'
      ? { ...common, action: 'user.timeline_viewed' }
      : { ...common, action: 'tenant.timeline_viewed' },
    db
  )
}

/**
 * Record that a staff member read a user's or a tenant's error issues:
 * `user.errors_viewed` or `tenant.errors_viewed`, with empty metadata,
 * written on the pool in the platform tenant, outside any transaction. It
 * always writes; the caller (platform-errors.service.ts) decides how often
 * to call it.
 * @param actor - The staff member.
 * @param platformTenantId - The platform tenant, where the entry is written.
 * @param kind - Whose errors.
 * @param targetId - The user or tenant id.
 * @returns The written row.
 * @throws {Error} When the insert fails.
 */
export async function recordErrorsView(
  actor: Actor,
  platformTenantId: string,
  kind: TimelineKind,
  targetId: string
): Promise<AuditLog> {
  const common = {
    actor,
    access: 'platform',
    tenantId: platformTenantId,
    targetId,
    metadata: {},
  } as const
  return writeEntry(
    kind === 'user'
      ? { ...common, action: 'user.errors_viewed' }
      : { ...common, action: 'tenant.errors_viewed' },
    db
  )
}

/**
 * Record that a staff member evaluated a user's flags in Apex:
 * `user.flags_evaluated`, with the tenant and client app evaluated for, written on
 * the pool in the platform tenant, outside any transaction. It always
 * writes; the caller (platform-flags.service.ts) decides how often to call it.
 * @param actor - The staff member.
 * @param platformTenantId - The platform tenant, where the entry is written.
 * @param userId - The user whose flags were evaluated.
 * @param metadata - The tenant (or null) and app evaluated for.
 * @returns The written row.
 * @throws {Error} When the metadata does not match the schema or the insert fails.
 */
export async function recordFlagsEvaluateView(
  actor: Actor,
  platformTenantId: string,
  userId: string,
  metadata: AuditMetadata<'user.flags_evaluated'>
): Promise<AuditLog> {
  return writeEntry(
    {
      actor,
      access: 'platform',
      tenantId: platformTenantId,
      targetId: userId,
      metadata,
      action: 'user.flags_evaluated',
    },
    db
  )
}

/**
 * Log a failed release.
 * @param error - The failure.
 */
function logUnreleasedDedupeKey(error: unknown): void {
  logger.warn('Could not release the platform access dedupe key', { error })
}

/**
 * Delete a dedupe key, logging rather than throwing on failure.
 * @param key - The key to delete.
 * @returns Resolves once deleted or logged.
 */
async function releaseDedupeKey(key: string): Promise<void> {
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.del(key)
      },
      'platform access dedupe release',
      logUnreleasedDedupeKey
    )
  } catch (error) {
    logUnreleasedDedupeKey(error)
  }
}

/**
 * A page of audit rows and the opaque cursor for the next one.
 */
export interface AuditLogPage {
  rows: AuditLogListRow[]
  nextCursor: string | null
}

/**
 * One keyset page under the given filters.
 * @param filters - Which entries to include.
 * @param query - The page size and the decoded cursor.
 * @param query.limit - The page size.
 * @param query.cursor - The decoded cursor, if any.
 * @returns The page, and `nextCursor` (null on the last page).
 */
async function listPage(
  filters: Omit<AuditLogListOptions, 'limit' | 'cursor'>,
  query: { limit: number; cursor?: { occurredAt: string; id: string } | undefined }
): Promise<AuditLogPage> {
  const cursor =
    query.cursor === undefined
      ? undefined
      : { occurredAt: new Date(query.cursor.occurredAt), id: query.cursor.id }
  const page = await auditLogRepository.list({ ...filters, limit: query.limit, cursor })
  const nextCursor =
    page.nextCursor === undefined
      ? // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null on the last page
        null
      : encodeCursor({
          occurredAt: page.nextCursor.occurredAt.toISOString(),
          id: page.nextCursor.id,
        })
  return { rows: page.rows, nextCursor }
}

/**
 * One tenant's audit log, newest first. The route has already checked the
 * caller's effective role.
 * @param tenantId - The tenant.
 * @param query - The validated query.
 * @returns The page.
 */
export async function listForTenant(
  tenantId: string,
  query: TenantAuditLogQuery
): Promise<AuditLogPage> {
  return listPage(
    { tenantId, action: query.action, actorUserId: query.actorUserId, access: query.access },
    query
  )
}

/**
 * Every tenant's audit log, newest first, for platform owners and admins.
 * @param query - The validated query.
 * @returns The page.
 */
export async function listPlatformWide(query: PlatformAuditLogQuery): Promise<AuditLogPage> {
  return listPage(
    {
      tenantId: query.tenantId,
      targetId: query.targetId,
      action: query.action,
      actorUserId: query.actorUserId,
      access: query.access,
    },
    query
  )
}
