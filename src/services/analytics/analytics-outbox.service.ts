/**
 * @file The only writer of `analytics_outbox`. Analytics never fails a user
 * action: inside a transaction every write runs in its own savepoint, so a
 * failed insert rolls back only itself and the caller's transaction stays
 * usable; on the pool it is a plain insert. Either way a failure is logged
 * at warn and swallowed. Nothing here calls PostHog; the drainer does.
 */
import { PgTransaction } from 'drizzle-orm/pg-core'
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import type { AuditAction } from '@/constants/audit.constants'
import type { NewAnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { AuditLog } from '@/database/models/audit-log.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import {
  auditEventName,
  buildAuditEvents,
} from '@/services/analytics/analytics-event-builder.service'
import type { DbExecutor } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import type { AuditEventExtras } from '@/types/analytics'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * Audit actions that change a tenant's group properties, so their event is
 * followed by a `$groupidentify` row.
 */
const TENANT_GROUP_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'tenant.created',
  'tenant.updated',
  'tenant.suspended',
  'tenant.reactivated',
  'tenant.archived',
])

/**
 * Audit actions that always change `metadata.userId`'s staff status: they
 * are filed in the platform tenant.
 */
const STAFF_STATUS_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'platform.member.auto_joined',
  'platform.member.granted',
])

/**
 * Audit actions that change a user's staff status when they happen in the
 * platform tenant: a role change or a removal (of `metadata.userId`), and an
 * accepted invitation (which makes the accepting actor staff).
 */
const PLATFORM_TENANT_MEMBER_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'member.role_changed',
  'member.removed',
  'invitation.accepted',
])

/**
 * The user whose staff status a staff-status action changes: the accepting
 * actor for `invitation.accepted`, `metadata.userId` for every other action.
 * @param entry - The inserted audit row.
 * @returns The user's id, or a non-string when the row names none.
 */
function affectedUserIdOf(entry: AuditLog): unknown {
  return entry.action === 'invitation.accepted' ? entry.actorUserId : entry.metadata.userId
}

/**
 * Run `write` in a savepoint of the caller's transaction, or directly on
 * the pool.
 * @param executor - The caller's transaction, or the pool.
 * @param write - The work, given the savepoint or the pool.
 * @returns Resolves once the work is done; rejects with its error.
 */
async function inSavepoint(
  executor: DbExecutor,
  write: (savepoint: DbExecutor) => Promise<void>
): Promise<void> {
  if (executor instanceof PgTransaction) {
    await executor.transaction(write)
    return
  }
  await write(executor)
}

/**
 * Log a failed outbox write at warn, with the event names only.
 * @param events - The names of the events that were not recorded.
 * @param error - What went wrong.
 */
function logWriteFailure(events: string[], error: unknown): void {
  logger.warn('Analytics outbox write failed', {
    error: redactedForLog(error),
    events,
    analyticsOutboxWriteFailed: events.length,
  })
}

/**
 * Write built rows to the outbox: in a savepoint when `executor` is a
 * transaction, as a plain insert on the pool otherwise. A no-op when
 * analytics is disabled or there are no rows. Never throws.
 * @param rows - The built events.
 * @param executor - The caller's transaction, or the pool.
 * @returns Resolves once the rows are written or the failure is logged.
 */
export async function enqueueAnalytics(
  rows: NewAnalyticsOutboxRow[],
  executor: DbExecutor
): Promise<void> {
  if (rows.length === 0 || !isAnalyticsEnabled()) return
  try {
    await inSavepoint(executor, (savepoint) =>
      analyticsOutboxRepository.insertMany(rows, savepoint)
    )
  } catch (error) {
    logWriteFailure(
      rows.map((row) => row.event),
      error
    )
  }
}

/**
 * The tenant and staff snapshots an audit row's action calls for, read
 * through `executor` so they see the uncommitted change.
 * @param entry - The inserted audit row.
 * @param executor - The savepoint, or the pool.
 * @returns The extras for `buildAuditEvents`.
 */
async function auditExtras(entry: AuditLog, executor: DbExecutor): Promise<AuditEventExtras> {
  const isTenantGroupAction = TENANT_GROUP_ACTIONS.has(entry.action)
  const isPlatformMemberAction = PLATFORM_TENANT_MEMBER_ACTIONS.has(entry.action)
  const tenant =
    isTenantGroupAction || isPlatformMemberAction
      ? await tenantRepository.findByIdIncludingDeleted(entry.tenantId, executor)
      : undefined
  const extras: AuditEventExtras = {}
  if (isTenantGroupAction && tenant) {
    extras.tenant = {
      id: tenant.id,
      name: tenant.name,
      status: tenant.lifecycleState,
      createdAt: tenant.createdAt,
      isPlatform: tenant.isPlatform,
    }
  }
  const affectedUserId = affectedUserIdOf(entry)
  const isStaffStatusChange =
    STAFF_STATUS_ACTIONS.has(entry.action) ||
    (isPlatformMemberAction && tenant?.isPlatform === true)
  if (isStaffStatusChange && typeof affectedUserId === 'string') {
    extras.staffStatus = {
      userId: affectedUserId,
      platformRole: await userMembershipRepository.findPlatformRole(affectedUserId, executor),
    }
  }
  return extras
}

/**
 * Forward one inserted audit row: read the snapshots its action needs,
 * build its rows and insert them, all in one savepoint of the caller's
 * transaction (or on the pool, for `recordPlatformAccess`). A no-op when
 * analytics is disabled. Never throws.
 * @param entry - The inserted audit row.
 * @param executor - The audit write's transaction, or the pool.
 * @returns Resolves once the rows are written or the failure is logged.
 */
export async function enqueueAuditAnalytics(entry: AuditLog, executor: DbExecutor): Promise<void> {
  if (!isAnalyticsEnabled()) return
  try {
    await inSavepoint(executor, async (savepoint) => {
      const extras = await auditExtras(entry, savepoint)
      const rows = buildAuditEvents(entry, currentAnalyticsContext(), extras)
      await analyticsOutboxRepository.insertMany(rows, savepoint)
    })
  } catch (error) {
    logWriteFailure([auditEventName(entry.action)], error)
  }
}
