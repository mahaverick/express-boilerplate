/**
 * @file PlatformStatsRepository against the real database. Day windows sit in
 * 2001, where only rows this file backdates can land, and totals are read as
 * deltas inside one repeatable-read snapshot, so rows other files left in this
 * worker's database cannot move them.
 */
import { randomUUID } from 'node:crypto'
import { sql as drizzleSql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { PlatformStatsRepository } from '@/repositories/platform-stats.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'

const repository = new PlatformStatsRepository()
const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const emailLogRepository = new EmailLogRepository()

function countOf(rows: { day: string; status: string; count: number }[], status: string): number {
  return rows.find((row) => row.day === '2001-05-02' && row.status === status)?.count ?? 0
}

describe('PlatformStatsRepository', () => {
  const userIds: string[] = []
  const tenantIds: string[] = []

  afterEach(async () => {
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  async function userCreatedAt(iso: string): Promise<string> {
    const user = await userRepository.create({ email: `stats-${randomUUID()}@example.test` })
    userIds.push(user.id)
    await sql`update users set created_at = ${iso} where id = ${user.id}`
    return user.id
  }

  async function tenantCreatedAt(iso: string, ownerId: string): Promise<void> {
    const slug = `stats-${randomUUID().slice(0, 8)}`
    const tenant = await tenantRepository.create({ name: slug, slug, ownerId })
    tenantIds.push(tenant.id)
    await sql`update tenants set created_at = ${iso} where id = ${tenant.id}`
  }

  it('buckets user and tenant sign-ups by UTC day, whatever the session time zone', async () => {
    const owner = await userCreatedAt('2001-03-02T23:59:59.999Z')
    await userCreatedAt('2001-03-03T00:00:00.000Z')
    await tenantCreatedAt('2001-03-03T12:00:00.000Z', owner)

    const result = await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`set local time zone 'Asia/Kolkata'`)
      return repository.signupsByDay(
        new Date('2001-03-01T00:00:00.000Z'),
        new Date('2001-03-08T00:00:00.000Z'),
        tx
      )
    })

    expect(result.users).toEqual([
      { day: '2001-03-02', count: 1 },
      { day: '2001-03-03', count: 1 },
    ])
    expect(result.tenants).toEqual([{ day: '2001-03-03', count: 1 }])
  })

  it('leaves out soft-deleted users', async () => {
    const id = await userCreatedAt('2001-04-02T10:00:00.000Z')
    await sql`update users set deleted_at = now() where id = ${id}`

    const result = await repository.signupsByDay(
      new Date('2001-04-01T00:00:00.000Z'),
      new Date('2001-04-08T00:00:00.000Z')
    )
    expect(result.users).toEqual([])
  })

  it('counts emails by UTC day and status', async () => {
    const from = new Date('2001-05-01T00:00:00.000Z')
    const to = new Date('2001-05-08T00:00:00.000Z')
    // email_logs is append-only, so earlier runs' rows stay; assert the delta.
    const before = await repository.emailsByDay(from, to)
    const recipient = `stats-mail-${randomUUID()}@example.test`
    await emailLogRepository.record({
      recipient,
      templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
      status: 'sent',
      createdAt: new Date('2001-05-02T08:00:00.000Z'),
    })
    await emailLogRepository.record({
      recipient,
      templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
      status: 'failed',
      errorCode: 'SMTP_TIMEOUT',
      createdAt: new Date('2001-05-02T09:00:00.000Z'),
    })

    const after = await repository.emailsByDay(from, to)
    expect(countOf(after, 'sent') - countOf(before, 'sent')).toBe(1)
    expect(countOf(after, 'failed') - countOf(before, 'failed')).toBe(1)
  })

  it('totals exclude the platform tenant and soft-deleted rows', async () => {
    await db.transaction(
      async (tx) => {
        const totals = await repository.totals(tx)
        const [live] = await tx.execute<{ tenants: number }>(
          drizzleSql`select count(*)::int as tenants from tenants where deleted_at is null`
        )
        // Same snapshot, so the only difference is the platform tenant.
        expect(totals.tenants).toBe((live?.tenants ?? 0) - 1)
      },
      { isolationLevel: 'repeatable read' }
    )
  })
})
