// src/services/retention.service.ts
//
// Deletes rows past their retention window, one rule per table. Each rule
// deletes in batches of RETENTION_BATCH_SIZE by primary key, each batch in its
// own short transaction, until a batch comes back short. A failing rule is
// logged and reported; the others still run. The maintenance worker runs this
// daily (maintenance.job.ts).
import { sql } from 'drizzle-orm'
import { getEnv, type Env } from '@/configs/env.config'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { db, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'

/**
 * The most rows one batch deletes.
 */
export const RETENTION_BATCH_SIZE = 5000

const DAY_MS = 86_400_000

const auditLogRepository = new AuditLogRepository()
const emailLogRepository = new EmailLogRepository()
const notificationRepository = new NotificationRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * Each rule's window in whole days; 0 turns the rule off.
 */
export interface RetentionDays {
  tokens: number
  invitations: number
  emailLogs: number
  notificationsRead: number
  notificationsUnread: number
  auditLogs: number
}

/**
 * One rule's outcome: its name (the table, qualified for notifications' two
 * rules), how many rows it deleted, and the error that stopped it, if any.
 */
export interface RetentionResult {
  table: string
  deleted: number
  error?: unknown
}

interface RetentionRule {
  table: string
  days: number
  purge: (cutoff: Date, limit: number, tx: DbTransaction) => Promise<number>
}

/**
 * The retention windows the environment configures.
 * @param env - The parsed environment.
 * @returns Each rule's days.
 */
export function retentionDays(env: Env): RetentionDays {
  return {
    tokens: env.RETENTION_TOKENS_DAYS,
    invitations: env.RETENTION_INVITATIONS_DAYS,
    emailLogs: env.RETENTION_EMAIL_LOGS_DAYS,
    notificationsRead: env.RETENTION_NOTIFICATIONS_READ_DAYS,
    notificationsUnread: env.RETENTION_NOTIFICATIONS_UNREAD_DAYS,
    auditLogs: env.RETENTION_AUDIT_LOGS_DAYS,
  }
}

/**
 * One audit batch. The trigger allows these deletes only in a transaction
 * that set both settings, transaction-locally, and only below the cutoff.
 * @param cutoff - Entries older than this go.
 * @param limit - The most rows the batch deletes.
 * @param tx - The batch's transaction.
 * @returns How many rows were deleted.
 */
async function purgeAuditLogs(cutoff: Date, limit: number, tx: DbTransaction): Promise<number> {
  await tx.execute(
    sql`select set_config('app.audit_purge', 'on', true), set_config('app.audit_purge_before', ${cutoff.toISOString()}, true)`
  )
  return auditLogRepository.purgeOccurredBefore(cutoff, limit, tx)
}

/**
 * The rules, in the order they run.
 * @param days - Each rule's window.
 * @returns One rule per table, two for notifications.
 */
function retentionRules(days: RetentionDays): RetentionRule[] {
  return [
    {
      table: 'user_tokens',
      days: days.tokens,
      purge: (cutoff, limit, tx) =>
        userTokenRepository.purgeExpiredOrRevokedBefore(cutoff, limit, tx),
    },
    {
      table: 'tenant_invitations',
      days: days.invitations,
      purge: (cutoff, limit, tx) =>
        tenantInvitationRepository.purgeSettledBefore(cutoff, limit, tx),
    },
    {
      table: 'email_logs',
      days: days.emailLogs,
      purge: (cutoff, limit, tx) => emailLogRepository.purgeCreatedBefore(cutoff, limit, tx),
    },
    {
      table: 'notifications.read',
      days: days.notificationsRead,
      purge: (cutoff, limit, tx) => notificationRepository.purgeReadBefore(cutoff, limit, tx),
    },
    {
      table: 'notifications.unread',
      days: days.notificationsUnread,
      purge: (cutoff, limit, tx) =>
        notificationRepository.purgeUnreadCreatedBefore(cutoff, limit, tx),
    },
    { table: 'audit_logs', days: days.auditLogs, purge: purgeAuditLogs },
  ]
}

/**
 * Run one rule to completion, batch by batch.
 * @param rule - The rule.
 * @param cutoff - Rows older than this go.
 * @returns Its outcome; a failure is reported, not thrown.
 */
async function runRule(rule: RetentionRule, cutoff: Date): Promise<RetentionResult> {
  let deleted = 0
  try {
    let batch = RETENTION_BATCH_SIZE
    while (batch === RETENTION_BATCH_SIZE) {
      batch = await db.transaction((tx) => rule.purge(cutoff, RETENTION_BATCH_SIZE, tx))
      deleted += batch
    }
    logger.info('retention purge', { table: rule.table, deleted })
    return { table: rule.table, deleted }
  } catch (error) {
    logger.error('retention purge failed', { table: rule.table, deleted, error })
    return { table: rule.table, deleted, error }
  }
}

/**
 * Purge every table past its retention window. A rule with 0 days is skipped.
 * @param now - The moment windows count back from. Defaults to the current time.
 * @param days - Each rule's window. Defaults to the environment's.
 * @returns One result per rule that ran, in order; a failed rule carries its error.
 */
export async function runRetentionPurge(
  now: Date = new Date(),
  days: RetentionDays = retentionDays(getEnv())
): Promise<RetentionResult[]> {
  const results: RetentionResult[] = []
  for (const rule of retentionRules(days)) {
    if (rule.days === 0) continue
    const cutoff = new Date(now.getTime() - rule.days * DAY_MS)
    results.push(await runRule(rule, cutoff))
  }
  return results
}
