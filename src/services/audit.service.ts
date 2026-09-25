// src/services/audit.service.ts
//
// The one writer of `audit_logs`. `record` validates an entry's metadata
// against its action's strict schema and throws on a mismatch, so a bad entry
// fails its caller's transaction instead of being dropped.
import {
  AUDIT_ACTIONS,
  PLATFORM_ACCESS_DEDUPE_SECONDS,
  type AuditAccess,
  type AuditAction,
  type AuditMetadata,
} from '@/constants/audit.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { AuditLog } from '@/database/models/audit-log.model'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requestContextStore } from '@/services/request-context.service'
import type { Actor } from '@/types/actor'

const auditLogRepository = new AuditLogRepository()

// Column widths in audit-log.model.ts.
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
 * Validate an entry and insert it, with request metadata from the ALS.
 * @param entry - The entry.
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
  return auditLogRepository.insert(
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
 * @throws {Error} When the insert fails; the dedupe key is released first.
 */
export async function recordPlatformAccess(
  actor: Actor,
  tenantId: string,
  platformRole: MembershipRole
): Promise<AuditLog | undefined> {
  const key = redisKey('audit', 'platform-access', actor.userId, tenantId)
  let hasClaimedKey = false
  try {
    const redis = await getRedis()
    const reply = await redis.set(key, '1', {
      condition: 'NX',
      expiration: { type: 'EX', value: PLATFORM_ACCESS_DEDUPE_SECONDS },
    })
    if (reply === null) return undefined
    hasClaimedKey = true
  } catch (error) {
    logger.warn('Platform access dedupe unavailable; writing the audit entry anyway', {
      error: error instanceof Error ? error.message : String(error),
    })
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
 * Delete a dedupe key, logging rather than throwing on failure.
 * @param key - The key to delete.
 * @returns Resolves once deleted or logged.
 */
async function releaseDedupeKey(key: string): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.del(key)
  } catch (error) {
    logger.warn('Could not release the platform access dedupe key', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
