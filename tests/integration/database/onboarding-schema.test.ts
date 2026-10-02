/**
 * @file What migration 0021 built, asserted against the live per-worker
 * database with raw SQL, so no application check stands in for the
 * database's: the onboarding_completions CHECKs and unique key, the delete
 * rules of every new foreign key, and the tenant columns' defaults.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { platformTenant } from '../../helpers/platform-staff'

const tenantIds: string[] = []
const userIds: string[] = []
// eslint-disable-next-line unicorn/no-null -- a SQL NULL parameter: postgres.js refuses undefined
const SQL_NULL = null

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * Insert a user with raw SQL, tracked for cleanup.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const id = randomUUID()
  const email = `schema-${id}@example.test`
  await sql`insert into users (id, email) values (${id}, ${email})`
  userIds.push(id)
  return id
}

/**
 * Insert a tenant with raw SQL, naming no onboarding column, tracked for cleanup.
 * @returns The tenant's id.
 */
async function insertTenant(): Promise<string> {
  const id = randomUUID()
  const slug = `schema-${id}`
  await sql`insert into tenants (id, name, slug) values (${id}, 'Schema Co', ${slug})`
  tenantIds.push(id)
  return id
}

/**
 * Insert one completion with raw SQL.
 * @param row - The columns to set.
 * @param row.tenantId - The tenant.
 * @param row.userId - The member, for a member step.
 * @param row.stepKey - The step key. Defaults to `configure_settings`.
 * @param row.source - The source. Defaults to `auto`.
 * @param row.completedBy - Who recorded it.
 * @param row.reason - The staff reason.
 * @returns The completion's id.
 */
async function insertCompletion(row: {
  tenantId: string
  userId?: string
  stepKey?: string
  source?: string
  completedBy?: string
  reason?: string
}): Promise<string> {
  const [inserted] = await sql<{ id: string }[]>`
    insert into onboarding_completions (tenant_id, user_id, step_key, source, completed_by, reason)
    values (${row.tenantId}, ${row.userId ?? SQL_NULL}, ${row.stepKey ?? 'configure_settings'},
      ${row.source ?? 'auto'}, ${row.completedBy ?? SQL_NULL}, ${row.reason ?? SQL_NULL})
    returning id`
  if (!inserted) throw new Error('completion insert returned no row')
  return inserted.id
}

describe('tenants onboarding columns', () => {
  it('leave a tenant inserted without them untracked, unstarted and undismissed', async () => {
    const tenantId = await insertTenant()
    const [row] = await sql`
      select onboarding_tracked, onboarding_started_at, onboarding_dismissed_at, onboarding_dismissed_by
      from tenants where id = ${tenantId}`
    expect(row).toEqual({
      onboarding_tracked: false,
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: no default
      onboarding_started_at: null,
      // eslint-disable-next-line unicorn/no-null -- as above
      onboarding_dismissed_at: null,
      // eslint-disable-next-line unicorn/no-null -- as above
      onboarding_dismissed_by: null,
    })
  })

  it('leave the seeded platform tenant untracked, and refuse to track it', async () => {
    const platform = await platformTenant()
    expect(platform.onboardingTracked).toBe(false)
    await expect(
      sql`update tenants set onboarding_tracked = true where id = ${platform.id}`
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'tenants_platform_untracked' })
  })

  it('clear onboarding_dismissed_by when the dismissing user is deleted', async () => {
    const tenantId = await insertTenant()
    const userId = await insertUser()
    await sql`
      update tenants set onboarding_tracked = true, onboarding_started_at = now(),
        onboarding_dismissed_at = now(), onboarding_dismissed_by = ${userId}
      where id = ${tenantId}`
    await sql`delete from users where id = ${userId}`
    const [row] = await sql`
      select onboarding_dismissed_by, onboarding_dismissed_at is not null as is_dismissed
      from tenants where id = ${tenantId}`
    // eslint-disable-next-line unicorn/no-null -- SQL NULL after ON DELETE SET NULL
    expect(row).toEqual({ onboarding_dismissed_by: null, is_dismissed: true })
  })
})

describe('onboarding_completions CHECKs', () => {
  it('refuses an unknown source', async () => {
    const tenantId = await insertTenant()
    await expect(insertCompletion({ tenantId, source: 'robot' })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'onboarding_completions_source_check',
    })
  })

  it('refuses a staff completion with no reason, and accepts one with a reason', async () => {
    const tenantId = await insertTenant()
    const staffId = await insertUser()
    await expect(
      insertCompletion({ tenantId, source: 'staff', completedBy: staffId })
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'onboarding_completions_staff_reason_check',
    })
    await expect(
      insertCompletion({ tenantId, source: 'staff', completedBy: staffId, reason: 'On a call' })
    ).resolves.toBeTypeOf('string')
  })

  it('refuses an auto completion that names who recorded it', async () => {
    const tenantId = await insertTenant()
    const userId = await insertUser()
    await expect(
      insertCompletion({ tenantId, source: 'auto', completedBy: userId })
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'onboarding_completions_auto_actor_check',
    })
  })

  it.each(['Configure', 'configure-settings', 'configure__settings'])(
    'refuses the step key %j',
    async (stepKey) => {
      const tenantId = await insertTenant()
      await expect(insertCompletion({ tenantId, stepKey })).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'onboarding_completions_step_key_check',
      })
    }
  )
})

describe('onboarding_completions_step_unique', () => {
  it('allows one tenant-step row per tenant, though user_id is null', async () => {
    const tenantId = await insertTenant()
    await insertCompletion({ tenantId })
    await expect(insertCompletion({ tenantId })).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'onboarding_completions_step_unique',
    })
  })

  it('allows one member-step row per member, and one for each member', async () => {
    const tenantId = await insertTenant()
    const first = await insertUser()
    const second = await insertUser()
    await insertCompletion({ tenantId, userId: first, stepKey: 'read_getting_started' })
    await insertCompletion({ tenantId, userId: second, stepKey: 'read_getting_started' })
    await expect(
      insertCompletion({ tenantId, userId: first, stepKey: 'read_getting_started' })
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('onboarding_completions foreign keys', () => {
  it("go with their tenant when it is deleted (a tenant purge's cascade)", async () => {
    const tenantId = await insertTenant()
    const userId = await insertUser()
    await insertCompletion({ tenantId })
    await insertCompletion({ tenantId, userId, stepKey: 'read_getting_started' })
    await sql`delete from tenants where id = ${tenantId}`
    expect(
      await sql`select 1 from onboarding_completions where tenant_id = ${tenantId}`
    ).toHaveLength(0)
  })

  it("delete a user's own member rows and clear completed_by on the rows they recorded", async () => {
    const tenantId = await insertTenant()
    const member = await insertUser()
    const recorder = await insertUser()
    await insertCompletion({ tenantId, userId: member, stepKey: 'read_getting_started' })
    const recorded = await insertCompletion({
      tenantId,
      source: 'staff',
      completedBy: recorder,
      reason: 'On a call',
    })

    await sql`delete from users where id = any(${[member, recorder]})`

    expect(await sql`select 1 from onboarding_completions where user_id = ${member}`).toHaveLength(
      0
    )
    const [row] =
      await sql`select completed_by, source from onboarding_completions where id = ${recorded}`
    // eslint-disable-next-line unicorn/no-null -- SQL NULL after ON DELETE SET NULL
    expect(row).toEqual({ completed_by: null, source: 'staff' })
  })
})
