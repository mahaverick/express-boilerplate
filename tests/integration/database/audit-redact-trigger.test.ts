/**
 * @file audit_logs' trigger as migration 0019 leaves it: an UPDATE passes
 * only inside a transaction that set `app.audit_redact`, and only when it
 * nulls the actor columns (actor_user_id, ip, user_agent) and changes
 * nothing else. Every other UPDATE, and every DELETE outside the purge
 * settings, still raises. Raw SQL throughout.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'

const tenantIds: string[] = []
const userIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  tenantIds.length = 0
  userIds.length = 0
})

/**
 * One user-actor audit row with an IP and user agent.
 * @returns The row's id and its actor's id.
 */
async function insertActorRow(): Promise<{ id: string; actorId: string }> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email) values (${`redact-${randomUUID()}@example.test`}) returning id
  `
  const [tenant] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Redact Co', ${`redact-${randomUUID()}`}) returning id
  `
  if (!user || !tenant) throw new Error('fixture insert returned no row')
  userIds.push(user.id)
  tenantIds.push(tenant.id)
  const [row] = await sql<{ id: string }[]>`
    insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, ip, user_agent)
    values ('user', ${user.id}, 'member', ${tenant.id}, 'tenant.updated', 'tenant', ${tenant.id}, '203.0.113.7', 'curl/8')
    returning id
  `
  if (!row) throw new Error('audit insert returned no row')
  return { id: row.id, actorId: user.id }
}

/**
 * Run one statement in a transaction that first sets `settings`.
 * @param settings - Setting name to value, applied with set_config(..., true).
 * @param write - The statement.
 * @returns Resolves when the transaction commits.
 */
async function withSettings(
  settings: Record<string, string>,
  write: (tx: typeof sql) => Promise<unknown>
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const [name, value] of Object.entries(settings)) {
      await tx`select set_config(${name}, ${value}, true)`
    }
    await write(tx as unknown as typeof sql)
  })
}

const REDACT = { 'app.audit_redact': 'on' }

describe('the audit redact exception', () => {
  it('lets a redacting transaction null the actor columns', async () => {
    const { id } = await insertActorRow()

    await withSettings(
      REDACT,
      (tx) =>
        tx`update audit_logs set actor_user_id = null, ip = null, user_agent = null where id = ${id}`
    )

    const [row] = await sql<
      { kind: string; actor: string | null; ip: string | null; ua: string | null; action: string }[]
    >`
      select actor_kind as kind, actor_user_id as actor, ip, user_agent as ua, action from audit_logs where id = ${id}
    `
    // The entry still says a person acted; only who is gone.
    // eslint-disable-next-line unicorn/no-null -- the redacted columns read back as SQL NULL
    expect(row).toEqual({ kind: 'user', actor: null, ip: null, ua: null, action: 'tenant.updated' })
  })

  it('refuses the same update without the setting', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(
        {},
        (tx) =>
          tx`update audit_logs set actor_user_id = null, ip = null, user_agent = null where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('refuses a redacting update that also changes another column', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(
        REDACT,
        (tx) =>
          tx`update audit_logs set actor_user_id = null, ip = null, user_agent = null, action = 'tenant.created' where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('refuses a redacting update that sets an actor instead of clearing it', async () => {
    const { id } = await insertActorRow()
    const { actorId: otherActor } = await insertActorRow()

    await expect(
      withSettings(
        REDACT,
        (tx) =>
          tx`update audit_logs set actor_user_id = ${otherActor}, ip = null, user_agent = null where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('refuses a redacting update that leaves the IP in place', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(
        REDACT,
        (tx) => tx`update audit_logs set actor_user_id = null, user_agent = null where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('refuses a redacting update that leaves the user agent in place', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(
        REDACT,
        (tx) => tx`update audit_logs set actor_user_id = null, ip = null where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('refuses a redacting update that also rewrites the metadata', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(
        REDACT,
        (tx) =>
          tx`update audit_logs set actor_user_id = null, ip = null, user_agent = null, metadata = '{"reason":"rewritten"}' where id = ${id}`
      )
    ).rejects.toThrow('audit_logs is append-only')
  })

  it('does not open DELETE', async () => {
    const { id } = await insertActorRow()

    await expect(
      withSettings(REDACT, (tx) => tx`delete from audit_logs where id = ${id}`)
    ).rejects.toThrow('audit_logs is append-only')
  })
})
