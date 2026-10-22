/**
 * @file Integration test against the real per-worker Postgres database (see
 * `tests/helpers/worker-database.ts`): every retention batch delete removes
 * at most its `limit`. The planner settings below force the plan in which an
 * `id in (select … limit n for update skip locked)` subquery is rescanned
 * for every outer row, each rescan taking the next unlocked rows; the
 * `= any(array(...))` form runs the subquery once whatever the plan. Rows are
 * dated in 1990, so no other file's rows fall under the cutoff.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { sql as drizzleSql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { EmailEventRepository } from '@/repositories/email-event.repository'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { db, sql, type DbTransaction } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackingRows, insertTestMessage } from '../../helpers/email-tracking'

const ROW_COUNT = 6
const LIMIT = 2
const ROWS_AT = '1990-01-01T00:00:00.000Z'
const CUTOFF = new Date('1991-01-01T00:00:00.000Z')
// Every address this file writes starts with this, so afterEach finds the rows.
const PREFIX = `retention-bound-${randomUUID()}-`
const PREFIX_LIKE = `${PREFIX}%`
const OUTBOX_EVENT = `retention_bound_${randomUUID().slice(0, 8)}`

const createdUserIds: string[] = []
const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  await sql`delete from analytics_outbox where event = ${OUTBOX_EVENT}`
  await sql`delete from email_logs where recipient like ${PREFIX_LIKE}`
  await deleteTrackingRows(PREFIX)
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * A fresh address under the file's prefix.
 */
function address(): string {
  return `${PREFIX}${randomUUID()}@example.test`
}

/**
 * Seed a user, tracked for cleanup; deleting it cascades its tokens and notifications.
 */
async function insertUser(): Promise<string> {
  const [row] = await sql<
    { id: string }[]
  >`insert into users (email) values (${address()}) returning id`
  if (!row) throw new Error('user insert returned no row')
  createdUserIds.push(row.id)
  return row.id
}

/**
 * Seed a tenant, tracked for cleanup; deleting it cascades its invitations.
 */
async function insertTenant(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Bound Co', ${`bound-${randomUUID()}`}) returning id
  `
  if (!row) throw new Error('tenant insert returned no row')
  createdTenantIds.push(row.id)
  return row.id
}

/**
 * Run `seedOne` `ROW_COUNT` times.
 */
async function seedRows(seedOne: () => Promise<unknown>): Promise<void> {
  for (let index = 0; index < ROW_COUNT; index += 1) await seedOne()
}

/**
 * Turn off every join, aggregate and sort strategy that would run the id
 * subquery only once, for the rest of the transaction.
 * @param tx - The batch's transaction.
 */
async function forceRescanningPlan(tx: DbTransaction): Promise<void> {
  for (const setting of [
    'enable_hashjoin',
    'enable_mergejoin',
    'enable_material',
    'enable_hashagg',
    'enable_sort',
  ]) {
    await tx.execute(drizzleSql.raw(`set local ${setting} = off`))
  }
}

/**
 * One batch delete under test: how to seed `ROW_COUNT` matching rows, and
 * the call that deletes a batch of them.
 */
interface BoundCase {
  name: string
  seed: () => Promise<void>
  purge: (tx: DbTransaction) => Promise<number>
}

const cases: BoundCase[] = [
  {
    name: 'UserTokenRepository.purgeExpiredOrRevokedBefore',
    seed: async () => {
      const userId = await insertUser()
      await seedRows(
        () => sql`
          insert into user_tokens (user_id, purpose, session_id, token_hash, expires_at)
          values (${userId}, 'refresh', ${randomUUID()}, ${randomBytes(32).toString('hex')}, ${ROWS_AT}::timestamptz)
        `
      )
    },
    purge: (tx) => new UserTokenRepository().purgeExpiredOrRevokedBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'TenantInvitationRepository.purgeSettledBefore',
    seed: async () => {
      const tenantId = await insertTenant()
      await seedRows(
        () => sql`
          insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
          values (${tenantId}, ${address()}, 'viewer', ${randomBytes(32).toString('hex')}, ${ROWS_AT}::timestamptz)
        `
      )
    },
    purge: (tx) => new TenantInvitationRepository().purgeSettledBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'EmailEventRepository.purgeForMessagesCreatedBefore',
    seed: async () => {
      const message = await insertTestMessage(PREFIX, { createdAt: ROWS_AT })
      await seedRows(
        () => sql`
          insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
          values (${message.id}, 'fake', ${randomUUID()}, 'delivered', ${ROWS_AT}::timestamptz)
        `
      )
    },
    purge: (tx) => new EmailEventRepository().purgeForMessagesCreatedBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'EmailLogRepository.purgeCreatedBefore',
    seed: () =>
      seedRows(
        () => sql`
          insert into email_logs (recipient, template_key, status, created_at)
          values (${address()}, 'password_reset', 'sent', ${ROWS_AT}::timestamptz)
        `
      ),
    purge: (tx) => new EmailLogRepository().purgeCreatedBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'EmailMessageRepository.purgeCreatedBefore',
    seed: () => seedRows(() => insertTestMessage(PREFIX, { createdAt: ROWS_AT })),
    purge: (tx) => new EmailMessageRepository().purgeCreatedBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'NotificationRepository.purgeReadBefore',
    seed: async () => {
      const userId = await insertUser()
      await seedRows(
        () => sql`
          insert into notifications (user_id, type, title, body, created_at, read_at)
          values (${userId}, 'tenant_invitation', 'Title', 'Body', ${ROWS_AT}::timestamptz, ${ROWS_AT}::timestamptz)
        `
      )
    },
    purge: (tx) => new NotificationRepository().purgeReadBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'NotificationRepository.purgeUnreadCreatedBefore',
    seed: async () => {
      const userId = await insertUser()
      await seedRows(
        () => sql`
          insert into notifications (user_id, type, title, body, created_at)
          values (${userId}, 'tenant_invitation', 'Title', 'Body', ${ROWS_AT}::timestamptz)
        `
      )
    },
    purge: (tx) => new NotificationRepository().purgeUnreadCreatedBefore(CUTOFF, LIMIT, tx),
  },
  {
    name: 'AuditLogRepository.purgeOccurredBefore',
    seed: async () => {
      const tenantId = await insertTenant()
      await seedRows(
        () => sql`
          insert into audit_logs (occurred_at, actor_kind, access, tenant_id, action, target_type, target_id)
          values (${ROWS_AT}::timestamptz, 'system', 'system', ${tenantId}, 'tenant.updated', 'tenant', ${tenantId})
        `
      )
    },
    purge: async (tx) => {
      // The append-only trigger allows the delete only in a retention purge transaction.
      await tx.execute(
        drizzleSql`select set_config('app.audit_purge', 'on', true), set_config('app.audit_purge_before', ${CUTOFF.toISOString()}, true)`
      )
      return new AuditLogRepository().purgeOccurredBefore(CUTOFF, LIMIT, tx)
    },
  },
  {
    name: 'AnalyticsOutboxRepository.deleteOlderThan',
    seed: () =>
      seedRows(
        () => sql`
          insert into analytics_outbox (event, distinct_id, properties, occurred_at)
          values (${OUTBOX_EVENT}, 'system', '{}'::jsonb, ${ROWS_AT}::timestamptz)
        `
      ),
    purge: (tx) => analyticsOutboxRepository.deleteOlderThan(CUTOFF, LIMIT, tx),
  },
]

describe('retention batch deletes stay within their limit', () => {
  it.each(cases)('$name deletes at most limit rows', async ({ seed, purge }) => {
    await seed()

    const deleted = await db.transaction(async (tx) => {
      await forceRescanningPlan(tx)
      return purge(tx)
    })

    expect(deleted).toBe(LIMIT)
  })
})
