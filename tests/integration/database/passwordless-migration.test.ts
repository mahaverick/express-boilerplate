/**
 * @file What migration 0029 removed: the `users.password_hash` column and the
 * `email_verification` and `password_reset` token purposes, asserted against
 * the real per-worker Postgres. A message stored under a retired template
 * key stays filterable in the staff email list.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { RETIRED_EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedMessage, deleteTrackedEmailRows } from '../../helpers/email-messages'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const userIds: string[] = []

afterEach(async () => {
  await deleteTrackedEmailRows()
  await truncateAuditLogs()
  await deleteTrackedUsers()
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * Insert a user with raw SQL, tracked for cleanup.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const id = randomUUID()
  const email = `passwordless-${id}@example.test`
  await sql`insert into users (id, email) values (${id}, ${email})`
  userIds.push(id)
  return id
}

describe('migration 0029', () => {
  it('has no users.password_hash column', async () => {
    const columns = await sql`
      select 1 from information_schema.columns
      where table_schema = current_schema() and table_name = 'users' and column_name = 'password_hash'`

    expect(columns).toHaveLength(0)
  })

  it.each(['password_reset', 'email_verification'])(
    'refuses a user_tokens row of purpose %s',
    async (purpose) => {
      const userId = await insertUser()

      await expect(sql`
        insert into user_tokens (purpose, user_id, session_id, token_hash, expires_at)
        values (${purpose}, ${userId}, ${randomUUID()}, ${randomBytes(32).toString('hex')},
          now() + interval '15 minutes')`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'user_tokens_purpose_check',
      })
    }
  )

  it('lets the email list filter by a retired template key', async () => {
    const { token } = await createTrackedStaff('viewer')
    const message = await createTrackedMessage({ templateKey: 'account_setup' })

    const response = await request(app)
      .get('/api/v1/platform/emails')
      .query({ template: 'account_setup' })
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    const items = (response.body as { data: { items: { id: string }[] } }).data.items
    expect(items.map((item) => item.id)).toContain(message.id)
  })

  it.each(RETIRED_EMAIL_TEMPLATE_KEYS)('accepts %s as a list filter', async (template) => {
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app)
      .get('/api/v1/platform/emails')
      .query({ template })
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
  })
})
