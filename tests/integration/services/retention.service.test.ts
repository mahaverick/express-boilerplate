/**
 * @file Exercises the retention purge against the real per-worker Postgres.
 * `now` is fixed in 2001 and every row is seeded around that date's
 * cutoffs. Every other file's rows carry the real current time and can't
 * match any predicate, so the `deleted` counts here are exact.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
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
import { deleteTrackingRows, insertTestMessage } from '../../helpers/email-tracking'
import { deferred, waitForWaiter } from '../../helpers/lock-probe'
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
  analyticsOutbox: 7,
}
// Every analytics_outbox row this file writes carries this event, so afterEach finds them.
const OUTBOX_EVENT = `retention_probe_${randomUUID().slice(0, 8)}`
// Every email_logs row this file writes starts with this, so afterEach finds them.
const RECIPIENT_PREFIX = `retention-${randomUUID()}-`
const RECIPIENT_LIKE = `${RECIPIENT_PREFIX}%`

const createdUserIds: string[] = []
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  await sql`delete from analytics_outbox where event = ${OUTBOX_EVENT}`
  await sql`delete from email_logs where recipient like ${RECIPIENT_LIKE}`
  await deleteTrackingRows(RECIPIENT_PREFIX)
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
 * One provider event for a message.
 * @param messageId - Its message.
 * @param occurredAt - Its occurred_at, ISO.
 * @returns Its id.
 */
async function insertEmailEvent(messageId: string, occurredAt: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
    values (${messageId}, 'fake', ${randomUUID()}, 'delivered', ${occurredAt}::timestamptz)
    returning id
  `
  if (!row) throw new Error('email event insert returned no row')
  return row.id
}

/**
 * One attempt row for a message.
 * @param messageId - Its message.
 * @param recipient - The message's recipient.
 * @param createdAt - Its own created_at, ISO.
 * @returns Its id.
 */
async function insertAttempt(
  messageId: string,
  recipient: string,
  createdAt: string
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_logs (recipient, template_key, status, message_id, created_at)
    values (${recipient}, 'password_reset', 'sent', ${messageId}, ${createdAt}::timestamptz)
    returning id
  `
  if (!row) throw new Error('attempt insert returned no row')
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

/**
 * One undelivered analytics outbox row.
 * @param occurredAt - Its occurred_at, ISO.
 * @returns Its id.
 */
async function insertOutboxRow(occurredAt: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into analytics_outbox (event, distinct_id, properties, occurred_at)
    values (${OUTBOX_EVENT}, 'system', '{}'::jsonb, ${occurredAt}::timestamptz)
    returning id
  `
  if (!row) throw new Error('outbox insert returned no row')
  return row.id
}

/**
 * Two rows from the same seed.
 * @param insert - Inserts one row.
 * @returns Both ids, in insert order.
 */
async function seedPair(insert: () => Promise<string>): Promise<[string, string]> {
  return [await insert(), await insert()]
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
    await insertOutboxRow(justOlder(DAYS.analyticsOutbox))

    const first = await runRetentionPurge(NOW, DAYS)
    // email_events and email_messages have nothing seeded here; the attempt row has no message.
    expect(first.map((result) => result.deleted)).toEqual([1, 1, 0, 1, 0, 1, 1, 1, 1])

    const second = await runRetentionPurge(NOW, DAYS)
    expect(second.map((result) => result.deleted)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
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

  it('skips a row another transaction holds, without waiting, and deletes it on the next run', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    const tokens = await seedPair(() => insertToken(userId, { expiresAt: justOlder(DAYS.tokens) }))
    const invitations = await seedPair(() =>
      insertInvitation(tenantId, { expiresAt: justOlder(DAYS.invitations) })
    )
    const emailLogs = await seedPair(() => insertEmailLog(justOlder(DAYS.emailLogs)))
    const read = await seedPair(() =>
      insertNotification(
        userId,
        justOlder(DAYS.notificationsUnread),
        justOlder(DAYS.notificationsRead)
      )
    )
    const unread = await seedPair(() =>
      insertNotification(userId, justOlder(DAYS.notificationsUnread))
    )
    const audit = await seedPair(() => insertAuditRow(tenantId, justOlder(DAYS.auditLogs)))
    const outbox = await seedPair(() => insertOutboxRow(justOlder(DAYS.analyticsOutbox)))
    // The first of each pair is held; its twin is free.
    const heldTokens = [tokens[0]]
    const heldInvitations = [invitations[0]]
    const heldEmailLogs = [emailLogs[0]]
    const heldNotifications = [read[0], unread[0]]
    const heldAudit = [audit[0]]
    const heldOutbox = [outbox[0]]

    const holder = postgres(getEnv().DATABASE_URL, { max: 1 })
    const locked = deferred<number>()
    const release = deferred()
    const holding = holder.begin(async (tx) => {
      await tx`select id from user_tokens where id = any(${heldTokens}) for update`
      await tx`select id from tenant_invitations where id = any(${heldInvitations}) for update`
      await tx`select id from email_logs where id = any(${heldEmailLogs}) for update`
      await tx`select id from notifications where id = any(${heldNotifications}) for update`
      await tx`select id from audit_logs where id = any(${heldAudit}) for update`
      await tx`select id from analytics_outbox where id = any(${heldOutbox}) for update`
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
      if (!row) throw new Error('pg_backend_pid() returned no row')
      locked.resolve(row.pid)
      await release.promise
    })

    try {
      const holderPid = await locked.promise
      const firstRun = runRetentionPurge(NOW, DAYS)
      expect(await waitForWaiter(holderPid, firstRun)).toBe(false)
      const first = await firstRun
      expect(first.map((result) => result.error)).toEqual(Array.from({ length: 9 }))
      expect(first.map((result) => result.deleted)).toEqual([1, 1, 0, 1, 0, 1, 1, 1, 1])
      expect(await surviving('user_tokens', tokens)).toEqual(heldTokens)
      expect(await surviving('tenant_invitations', invitations)).toEqual(heldInvitations)
      expect(await surviving('email_logs', emailLogs)).toEqual(heldEmailLogs)
      expect(await surviving('notifications', [...read, ...unread])).toEqual(
        sorted(heldNotifications)
      )
      expect(await surviving('audit_logs', audit)).toEqual(heldAudit)
      expect(await surviving('analytics_outbox', outbox)).toEqual(heldOutbox)
    } finally {
      release.resolve()
      await holding
      await holder.end({ timeout: 5 })
    }

    const second = await runRetentionPurge(NOW, DAYS)
    expect(second.map((result) => result.deleted)).toEqual([1, 1, 0, 1, 0, 1, 1, 1, 1])
    expect(await surviving('user_tokens', tokens)).toEqual([])
    expect(await surviving('tenant_invitations', invitations)).toEqual([])
    expect(await surviving('email_logs', emailLogs)).toEqual([])
    expect(await surviving('notifications', [...read, ...unread])).toEqual([])
    expect(await surviving('audit_logs', audit)).toEqual([])
    expect(await surviving('analytics_outbox', outbox)).toEqual([])
  })

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
            'email_events',
            'email_logs',
            'email_messages',
            'notifications.read',
            'notifications.unread',
            'audit_logs',
            'analytics_outbox',
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
        { table: 'email_events', deleted: 0 },
        { table: 'email_logs', deleted: 1 },
        { table: 'email_messages', deleted: 0 },
        { table: 'notifications.read', deleted: 0 },
        { table: 'notifications.unread', deleted: 0 },
        { table: 'analytics_outbox', deleted: 0 },
      ])
    } finally {
      loggerInfo.mockRestore()
    }
  })

  it('dates the email group by its message: an old message goes with its events and attempts, a newer one stays whole', async () => {
    const old = await insertTestMessage(RECIPIENT_PREFIX, { createdAt: justOlder(DAYS.emailLogs) })
    const oldEvent = await insertEmailEvent(old.id, LATER)
    const oldAttempt = await insertAttempt(old.id, old.recipient, LATER)
    const recent = await insertTestMessage(RECIPIENT_PREFIX, {
      createdAt: justNewer(DAYS.emailLogs),
    })
    const recentEvent = await insertEmailEvent(recent.id, justNewer(DAYS.emailLogs))
    // Backdated past the cutoff: an attempt is kept while its message is.
    const recentAttempt = await insertAttempt(
      recent.id,
      recent.recipient,
      justOlder(DAYS.emailLogs)
    )

    const results = await runRetentionPurge(NOW, DAYS)

    expect(deletedBy(results, 'email_events')).toBe(1)
    expect(deletedBy(results, 'email_logs')).toBe(1)
    expect(deletedBy(results, 'email_messages')).toBe(1)
    expect(await surviving('email_messages', [old.id, recent.id])).toEqual([recent.id])
    expect(await surviving('email_events', [oldEvent, recentEvent])).toEqual([recentEvent])
    expect(await surviving('email_logs', [oldAttempt, recentAttempt])).toEqual([recentAttempt])
  })

  it('keeps a message whose attempt is held, without waiting, and deletes both on the next run', async () => {
    const old = await insertTestMessage(RECIPIENT_PREFIX, { createdAt: justOlder(DAYS.emailLogs) })
    const event = await insertEmailEvent(old.id, justOlder(DAYS.emailLogs))
    const attempt = await insertAttempt(old.id, old.recipient, justOlder(DAYS.emailLogs))

    const holder = postgres(getEnv().DATABASE_URL, { max: 1 })
    const locked = deferred<number>()
    const release = deferred()
    const holding = holder.begin(async (tx) => {
      await tx`select id from email_logs where id = ${attempt} for update`
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`
      if (!row) throw new Error('pg_backend_pid() returned no row')
      locked.resolve(row.pid)
      await release.promise
    })

    try {
      const holderPid = await locked.promise
      const firstRun = runRetentionPurge(NOW, DAYS)
      expect(await waitForWaiter(holderPid, firstRun)).toBe(false)
      const first = await firstRun
      expect(deletedBy(first, 'email_events')).toBe(1)
      expect(deletedBy(first, 'email_logs')).toBe(0)
      // Its attempt is still there, so the message is left for the next run rather than cascaded.
      expect(deletedBy(first, 'email_messages')).toBe(0)
      expect(await surviving('email_events', [event])).toEqual([])
      expect(await surviving('email_messages', [old.id])).toEqual([old.id])
    } finally {
      release.resolve()
      await holding
      await holder.end({ timeout: 5 })
    }

    const second = await runRetentionPurge(NOW, DAYS)
    expect(deletedBy(second, 'email_logs')).toBe(1)
    expect(deletedBy(second, 'email_messages')).toBe(1)
    expect(await surviving('email_logs', [attempt])).toEqual([])
    expect(await surviving('email_messages', [old.id])).toEqual([])
  })

  it('drops analytics outbox rows past the window undelivered, keeps newer ones, and warns with the count', async () => {
    const old = await insertOutboxRow(justOlder(DAYS.analyticsOutbox))
    const recent = await insertOutboxRow(justNewer(DAYS.analyticsOutbox))
    const loggerWarn = vi.spyOn(logger, 'warn')

    try {
      const results = await runRetentionPurge(NOW, DAYS)

      expect(deletedBy(results, 'analytics_outbox')).toBe(1)
      expect(await surviving('analytics_outbox', [old, recent])).toEqual([recent])
      expect(loggerWarn).toHaveBeenCalledWith('analytics outbox rows dropped undelivered', {
        analyticsOutboxDropped: 1,
      })
    } finally {
      loggerWarn.mockRestore()
    }
  })

  it('does not warn when the analytics outbox rule dropped nothing', async () => {
    await insertOutboxRow(justNewer(DAYS.analyticsOutbox))
    const loggerWarn = vi.spyOn(logger, 'warn')

    try {
      const results = await runRetentionPurge(NOW, DAYS)

      expect(deletedBy(results, 'analytics_outbox')).toBe(0)
      expect(loggerWarn).not.toHaveBeenCalledWith(
        'analytics outbox rows dropped undelivered',
        expect.anything()
      )
    } finally {
      loggerWarn.mockRestore()
    }
  })

  it('never expires a suppression', async () => {
    const address = `${RECIPIENT_PREFIX}${randomUUID()}@example.test`
    const [row] = await sql<{ id: string }[]>`
      insert into email_suppressions (address, reason, created_at)
      values (${address}, 'hard_bounce', ${justOlder(DAYS.auditLogs * 10)}::timestamptz)
      returning id`
    if (!row) throw new Error('suppression insert returned no row')

    await runRetentionPurge(NOW, DAYS)

    expect(await surviving('email_suppressions', [row.id])).toEqual([row.id])
  })
})
