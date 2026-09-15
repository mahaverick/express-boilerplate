// tests/integration/database/migrate.test.ts
//
// The migration itself already ran once, in the main process, before this
// file was ever loaded — see tests/helpers/global-setup.ts. These tests
// assert what that migration actually produced.
import { describe, expect, it } from 'vitest'
import { runMigrations } from '@/database/migrate'
import { sql } from '@/services/database.service'

describe('migrations', () => {
  it('creates the users table', async () => {
    const rows = await sql`
      select column_name from information_schema.columns
      where table_name = 'users'
    `
    const columns = rows.map((r) => r.column_name as string)
    expect(columns).toEqual(expect.arrayContaining(['id', 'email', 'password_hash', 'created_at']))
  })

  it('creates the user_tokens table', async () => {
    const rows = await sql`
      select column_name from information_schema.columns
      where table_name = 'user_tokens'
    `
    const columns = rows.map((r) => r.column_name as string)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'session_id',
        'token_hash',
        'expires_at',
        'revoked_at',
        'replaced_by_id',
        'created_at',
      ])
    )
  })

  it('cascades a user_tokens row when its owning user is deleted', async () => {
    const email = `token-cascade-${Date.now()}@example.test`
    const [user] = await sql`insert into users (email) values (${email}) returning id`
    const userId = user?.id as string
    const [token] = await sql`
      insert into user_tokens (user_id, session_id, token_hash, expires_at)
      values (${userId}, ${crypto.randomUUID()}, ${'a'.repeat(64)}, now() + interval '1 day')
      returning id
    `

    await sql`delete from users where id = ${userId}`

    const remaining = await sql`select 1 from user_tokens where id = ${token?.id as string}`
    expect(remaining).toHaveLength(0)
  })

  it('enforces case-insensitive email uniqueness at the database level', async () => {
    const email = `dup-${Date.now()}@example.test`
    await sql`insert into users (email) values (${email})`
    // The UPPERCASE variant must be rejected by the index, not by app code.
    await expect(sql`insert into users (email) values (${email.toUpperCase()})`).rejects.toThrow()
    await sql`delete from users where lower(email) = lower(${email})`
  })

  it('is safe to run again once every migration is already applied', async () => {
    // runMigrations() closes the pool it uses when it finishes, so this
    // must be the last test in the file — sql/db are module-scope singletons
    // shared by every test above within this same test file.
    await expect(runMigrations()).resolves.toBeUndefined()
  })
})
