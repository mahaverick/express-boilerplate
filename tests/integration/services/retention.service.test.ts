// tests/integration/services/retention.service.test.ts
//
// The retention purge against the real per-worker Postgres. `now` is fixed
// in 2001 and every row is seeded around that date's cutoffs. Every other
// file's rows carry the real current time and can't match any predicate, so
// the `deleted` counts here are exact.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import {
  RETENTION_BATCH_SIZE,
  runRetentionPurge,
  type RetentionDays,
  type RetentionResult,
} from '@/services/retention.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const NOW = new Date('2001-01-01T03:00:00.000Z')
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const DAYS: RetentionDays = {
  tokens: 7,
  invitations: 30,
  emailLogs: 90,
  notificationsRead: 90,
  notificationsUnread: 365,
  auditLogs: 400,
}
// Every email_logs row this file writes starts with this, so afterEach finds them.
const RECIPIENT_PREFIX = `retention-${randomUUID()}-`
const RECIPIENT_LIKE = `${RECIPIENT_PREFIX}%`

const createdUserIds: string[] = []
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  await sql`delete from email_logs where recipient like ${RECIPIENT_LIKE}`
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * `days` before NOW, shifted by `offsetMs`, as ISO text: raw SQL binds it with ::timestamptz.
 * @param days - Days before NOW; negative is after it.
 * @param offsetMs - Added after.
 * @returns The ISO timestamp.
 */
function daysBefore(days: number, offsetMs = 0): string {
  return new Date(NOW.getTime() - days * DAY_MS + offsetMs).toISOString()
}

/**
 * One minute past a rule's cutoff, on the side that is deleted.
 * @param days - The rule's days.
 * @returns The ISO timestamp.
 */
function justOlder(days: number): string {
  return daysBefore(days, -MINUTE_MS)
}

/**
 * One minute short of a rule's cutoff, on the side that is kept.
 * @param days - The rule's days.
 * @returns The ISO timestamp.
 */
function justNewer(days: number): string {
  return daysBefore(days, MINUTE_MS)
}

const LATER = daysBefore(-30)

/**
 * A nullable timestamptz value for raw SQL.
 * @param value - ISO text, or undefined for NULL.
 * @returns The SQL fragment.
 */
function timestampOrNull(value: string | undefined) {
  return value === undefined ? sql`null` : sql`${value}::timestamptz`
}

/**
 * How many rows one rule's result says it deleted.
 * @param results - A run's results.
 * @param table - The rule's name.
 * @returns Its count, or undefined when the rule did not run.
 */
function deletedBy(results: RetentionResult[], table: string): number | undefined {
  return results.find((result) => result.table === table)?.deleted
}

/**
 * Which of `ids` still exist in `table`.
 * @param table - The table.
 * @param ids - Ids seeded by the test.
 * @returns The surviving ids, sorted.
 */
async function surviving(table: string, ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from ${sql(table)} where id = any(${ids})`
  return rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b))
}

/**
 * Sort ids for comparison with `surviving`.
 * @param ids - Ids.
 * @returns A sorted copy.
 */
function sorted(ids: string[]): string[] {
  return ids.toSorted((a, b) => a.localeCompare(b))
}

/**
 * A user, tracked for cleanup; deleting it cascades its tokens and notifications.
 * @returns Its id.
 */
async function insertUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email) values (${`${RECIPIENT_PREFIX}${randomUUID()}@example.test`}) returning id
  `
  if (!row) throw new Error('user insert returned no row')
  createdUserIds.push(row.id)
  return row.id
}

/**
 * A tenant, tracked for cleanup; deleting it cascades its invitations.
 * @returns Its id.
 */
async function insertTenant(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Retention Co', ${`retention-${randomUUID()}`}) returning id
  `
  if (!row) throw new Error('tenant insert returned no row')
  createdTenantIds.push(row.id)
  return row.id
}

interface TokenSeed {
  expiresAt: string
  revokedAt?: string
  consumedAt?: string
  replacedById?: string
}

/**
 * One refresh-token row.
 * @param userId - Its owner.
 * @param seed - Its timestamps and successor.
 * @returns Its id.
 */
async function insertToken(userId: string, seed: TokenSeed): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into user_tokens
      (user_id, purpose, session_id, token_hash, expires_at, revoked_at, consumed_at, replaced_by_id)
    values (
      ${userId}, 'refresh', ${randomUUID()}, ${randomBytes(32).toString('hex')},
      ${seed.expiresAt}::timestamptz, ${timestampOrNull(seed.revokedAt)},
      ${timestampOrNull(seed.consumedAt)}, ${seed.replacedById ?? sql`null`}
    )
    returning id
  `
  if (!row) throw new Error('token insert returned no row')
  return row.id
}

interface InvitationSeed {
  expiresAt: string
  acceptedAt?: string
  revokedAt?: string
}

/**
 * One invitation row, with a unique address so pending rows never collide.
 * @param tenantId - Its tenant.
 * @param seed - Its timestamps.
 * @returns Its id.
 */
async function insertInvitation(tenantId: string, seed: InvitationSeed): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at, accepted_at, revoked_at)
    values (
      ${tenantId}, ${`${RECIPIENT_PREFIX}${randomUUID()}@example.test`}, 'viewer',
      ${randomBytes(32).toString('hex')}, ${seed.expiresAt}::timestamptz,
      ${timestampOrNull(seed.acceptedAt)}, ${timestampOrNull(seed.revokedAt)}
    )
    returning id
  `
  if (!row) throw new Error('invitation insert returned no row')
  return row.id
}

/**
 * One email_logs row.
 * @param createdAt - Its created_at, ISO.
 * @returns Its id.
 */
async function insertEmailLog(createdAt: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_logs (recipient, template_key, status, created_at)
    values (${`${RECIPIENT_PREFIX}${randomUUID()}@example.test`}, 'password_reset', 'sent', ${createdAt}::timestamptz)
    returning id
  `
  if (!row) throw new Error('email log insert returned no row')
  return row.id
}

/**
 * One notification row.
 * @param userId - Its owner.
 * @param createdAt - Its created_at, ISO.
 * @param readAt - Its read_at, ISO, or undefined for unread.
 * @returns Its id.
 */
async function insertNotification(
  userId: string,
  createdAt: string,
  readAt?: string
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into notifications (user_id, type, title, body, read_at, created_at)
    values (${userId}, 'verify_email', 'Title', 'Body', ${timestampOrNull(readAt)}, ${createdAt}::timestamptz)
    returning id
  `
  if (!row) throw new Error('notification insert returned no row')
  return row.id
}

/**
 * One system-actor audit row.
 * @param tenantId - Its tenant.
 * @param occurredAt - Its occurred_at, ISO.
 * @returns Its id.
 */
async function insertAuditRow(tenantId: string, occurredAt: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into audit_logs (occurred_at, actor_kind, access, tenant_id, action, target_type, target_id)
    values (${occurredAt}::timestamptz, 'system', 'system', ${tenantId}, 'tenant.updated', 'tenant', ${tenantId})
    returning id
  `
  if (!row) throw new Error('audit insert returned no row')
  return row.id
}

describe('runRetentionPurge', () => {
  it('deletes tokens expired, or revoked unused, before the cutoff, and keeps rotated ones until they expire', async () => {
    const userId = await insertUser()
    const days = DAYS.tokens
    const expiredOld = await insertToken(userId, { expiresAt: justOlder(days) })
    const expiredNew = await insertToken(userId, { expiresAt: justNewer(days) })
    const killedOld = await insertToken(userId, { expiresAt: LATER, revokedAt: justOlder(days) })
    const killedNew = await insertToken(userId, { expiresAt: LATER, revokedAt: justNewer(days) })
    const rotatedOld = await insertToken(userId, {
      expiresAt: LATER,
      revokedAt: justOlder(days),
      consumedAt: justOlder(days),
    })

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'user_tokens')).toBe(2)
    expect(
      await surviving('user_tokens', [expiredOld, expiredNew, killedOld, killedNew, rotatedOld])
    ).toEqual(sorted([expiredNew, killedNew, rotatedOld]))
  })

  it('deletes a whole rotation chain in one run', async () => {
    const userId = await insertUser()
    const old = justOlder(DAYS.tokens)
    const third = await insertToken(userId, { expiresAt: old })
    const second = await insertToken(userId, {
      expiresAt: old,
      revokedAt: old,
      consumedAt: old,
      replacedById: third,
    })
    const first = await insertToken(userId, {
      expiresAt: old,
      revokedAt: old,
      consumedAt: old,
      replacedById: second,
    })

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'user_tokens')).toBe(3)
    expect(await surviving('user_tokens', [first, second, third])).toEqual([])
  })

  it('deletes a token a kept predecessor points to, and clears that pointer', async () => {
    const userId = await insertUser()
    const old = justOlder(DAYS.tokens)
    // Revoked unused (a logout ended the session): past retention.
    const successor = await insertToken(userId, { expiresAt: LATER, revokedAt: old })
    // Rotated away and not yet expired: kept, still pointing at the successor.
    const predecessor = await insertToken(userId, {
      expiresAt: LATER,
      revokedAt: old,
      consumedAt: old,
      replacedById: successor,
    })

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'user_tokens')).toBe(1)
    expect(await surviving('user_tokens', [successor, predecessor])).toEqual([predecessor])
    const [row] = await sql<{ replacedById: string | null }[]>`
      select replaced_by_id as "replacedById" from user_tokens where id = ${predecessor}
    `
    expect(row?.replacedById).toBeNull()
  })

  it('deletes an expired predecessor and leaves its live successor alone', async () => {
    const userId = await insertUser()
    const old = justOlder(DAYS.tokens)
    const live = await insertToken(userId, { expiresAt: LATER })
    const expired = await insertToken(userId, {
      expiresAt: old,
      revokedAt: old,
      consumedAt: old,
      replacedById: live,
    })

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'user_tokens')).toBe(1)
    expect(await surviving('user_tokens', [live, expired])).toEqual([live])
  })

  it('dates an invitation by the latest of its expiry, acceptance and revocation', async () => {
    const tenantId = await insertTenant()
    const days = DAYS.invitations
    const pendingOld = await insertInvitation(tenantId, { expiresAt: justOlder(days) })
    const pendingNew = await insertInvitation(tenantId, { expiresAt: justNewer(days) })
    const revokedOld = await insertInvitation(tenantId, {
      expiresAt: daysBefore(days + 10),
      revokedAt: justOlder(days),
    })
    const acceptedNew = await insertInvitation(tenantId, {
      expiresAt: daysBefore(days + 10),
      acceptedAt: justNewer(days),
    })
    const acceptedOldExpiresNew = await insertInvitation(tenantId, {
      expiresAt: justNewer(days),
      acceptedAt: justOlder(days),
    })

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'tenant_invitations')).toBe(2)
    expect(
      await surviving('tenant_invitations', [
        pendingOld,
        pendingNew,
        revokedOld,
        acceptedNew,
        acceptedOldExpiresNew,
      ])
    ).toEqual(sorted([pendingNew, acceptedNew, acceptedOldExpiresNew]))
  })

  it('deletes email logs created before the cutoff', async () => {
    const old = await insertEmailLog(justOlder(DAYS.emailLogs))
    const recent = await insertEmailLog(justNewer(DAYS.emailLogs))

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'email_logs')).toBe(1)
    expect(await surviving('email_logs', [old, recent])).toEqual([recent])
  })

  it('dates a read notification by read_at and an unread one by created_at, each with its own window', async () => {
    const userId = await insertUser()
    const longAgo = daysBefore(DAYS.notificationsUnread + 10)
    const readOld = await insertNotification(userId, longAgo, justOlder(DAYS.notificationsRead))
    const readNew = await insertNotification(userId, longAgo, justNewer(DAYS.notificationsRead))
    const unreadOld = await insertNotification(userId, justOlder(DAYS.notificationsUnread))
    const unreadNew = await insertNotification(userId, justNewer(DAYS.notificationsUnread))
    const unreadPastReadWindow = await insertNotification(userId, justOlder(DAYS.notificationsRead))

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'notifications.read')).toBe(1)
    expect(deletedBy(results, 'notifications.unread')).toBe(1)
    expect(
      await surviving('notifications', [
        readOld,
        readNew,
        unreadOld,
        unreadNew,
        unreadPastReadWindow,
      ])
    ).toEqual(sorted([readNew, unreadNew, unreadPastReadWindow]))
  })

  it('deletes audit rows older than the cutoff when the audit window is set', async () => {
    const tenantId = await insertTenant()
    const old = await insertAuditRow(tenantId, justOlder(DAYS.auditLogs))
    const recent = await insertAuditRow(tenantId, justNewer(DAYS.auditLogs))

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'audit_logs')).toBe(1)
    expect(await surviving('audit_logs', [old, recent])).toEqual([recent])
  })

  it('touches no audit row, and reports no audit rule, when the audit window is 0', async () => {
    const tenantId = await insertTenant()
    const old = await insertAuditRow(tenantId, daysBefore(DAYS.auditLogs + 1000))

    const results = await runRetentionPurge(NOW, { ...DAYS, auditLogs: 0 })

    expect(results.map((result) => result.table)).not.toContain('audit_logs')
    expect(await surviving('audit_logs', [old])).toEqual([old])
  })

  it('deletes nothing on a second run', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    await insertToken(userId, { expiresAt: justOlder(DAYS.tokens) })
    await insertInvitation(tenantId, { expiresAt: justOlder(DAYS.invitations) })
    await insertEmailLog(justOlder(DAYS.emailLogs))
    await insertNotification(userId, justOlder(DAYS.notificationsUnread))
    await insertNotification(
      userId,
      justOlder(DAYS.notificationsUnread),
      justOlder(DAYS.notificationsRead)
    )
    await insertAuditRow(tenantId, justOlder(DAYS.auditLogs))

    const first = await runRetentionPurge(NOW, DAYS)
    expect(first.map((result) => result.deleted)).toEqual([1, 1, 1, 1, 1, 1])

    const second = await runRetentionPurge(NOW, DAYS)
    expect(second.map((result) => result.deleted)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('loops in batches of RETENTION_BATCH_SIZE until a batch comes back short', async () => {
    await sql`
      insert into email_logs (recipient, template_key, status, created_at)
      select ${RECIPIENT_PREFIX} || g::text || '@example.test', 'password_reset', 'sent',
             ${justOlder(DAYS.emailLogs)}::timestamptz
      from generate_series(1, ${RETENTION_BATCH_SIZE + 1}) as g
    `
    const purge = vi.spyOn(EmailLogRepository.prototype, 'purgeCreatedBefore')

    try {
      const results = await runRetentionPurge(NOW, DAYS)
      expect(deletedBy(results, 'email_logs')).toBe(RETENTION_BATCH_SIZE + 1)
      expect(purge).toHaveBeenCalledTimes(2)
    } finally {
      purge.mockRestore()
    }
  }, 30_000)

  it('runs every other rule when one fails, and reports and logs that one', async () => {
    const old = await insertEmailLog(justOlder(DAYS.emailLogs))
    const loggerError = vi.spyOn(logger, 'error')

    try {
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'purgeSettledBefore',
        () => Promise.reject(new Error('invitation purge failed')),
        async () => {
          const results = await runRetentionPurge(NOW, DAYS)

          expect(results.map((result) => result.table)).toEqual([
            'user_tokens',
            'tenant_invitations',
            'email_logs',
            'notifications.read',
            'notifications.unread',
            'audit_logs',
          ])
          const invitations = results.find((result) => result.table === 'tenant_invitations')
          expect(invitations?.deleted).toBe(0)
          expect(invitations?.error).toMatchObject({ message: 'invitation purge failed' })
          expect(deletedBy(results, 'email_logs')).toBe(1)
          expect(await surviving('email_logs', [old])).toEqual([])
          expect(loggerError).toHaveBeenCalledWith(
            'retention purge failed',
            expect.objectContaining({ table: 'tenant_invitations', deleted: 0 })
          )
        }
      )
    } finally {
      loggerError.mockRestore()
    }
  })

  it('logs one info line per rule that ran, with its count', async () => {
    await insertEmailLog(justOlder(DAYS.emailLogs))
    const loggerInfo = vi.spyOn(logger, 'info')

    try {
      await runRetentionPurge(NOW, { ...DAYS, auditLogs: 0 })
      expect(
        loggerInfo.mock.calls
          .filter(([message]) => message === 'retention purge')
          .map(([, meta]) => meta)
      ).toEqual([
        { table: 'user_tokens', deleted: 0 },
        { table: 'tenant_invitations', deleted: 0 },
        { table: 'email_logs', deleted: 1 },
        { table: 'notifications.read', deleted: 0 },
        { table: 'notifications.unread', deleted: 0 },
      ])
    } finally {
      loggerInfo.mockRestore()
    }
  })
})
