/**
 * @file The migration itself already ran once, in the main process, before
 * this file was ever loaded — see `tests/helpers/global-setup.ts`. These
 * tests assert what that migration actually produced.
 */
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
        'purpose',
        'session_id',
        'token_hash',
        'expires_at',
        'revoked_at',
        'consumed_at',
        'replaced_by_id',
        'created_at',
      ])
    )
  })

  /**
   * Migration 0004 dropped 0003's transient DEFAULT 'refresh'; the
   * Drizzle-schema type gate can't see the live database, so this asserts
   * the column itself.
   */
  it('user_tokens.purpose has no default and is not nullable at the database level', async () => {
    const [column] = await sql`
      select column_default, is_nullable from information_schema.columns
      where table_name = 'user_tokens' and column_name = 'purpose'
    `
    expect(column).toBeDefined()
    expect(column?.column_default).toBeNull()
    expect(column?.is_nullable).toBe('NO')
  })

  /**
   * Migration 0005's `user_tokens_purpose_check` backs `$type<TokenPurpose>()`
   * (compile-time only) with a database-level CHECK, via a raw insert that
   * bypasses Drizzle's typing.
   */
  it('rejects an invalid purpose value at the database level via its CHECK constraint', async () => {
    const email = `invalid-purpose-${Date.now()}@example.test`
    const [user] = await sql`insert into users (email) values (${email}) returning id`
    const userId = user?.id as string

    await expect(
      sql`
        insert into user_tokens (user_id, purpose, token_hash, expires_at)
        values (${userId}, 'bogus', ${'c'.repeat(64)}, now() + interval '1 day')
      `
    ).rejects.toThrow()

    await sql`delete from users where id = ${userId}`
  })

  it('cascades a user_tokens row when its owning user is deleted', async () => {
    const email = `token-cascade-${Date.now()}@example.test`
    const [user] = await sql`insert into users (email) values (${email}) returning id`
    const userId = user?.id as string
    const [token] = await sql`
      insert into user_tokens (user_id, purpose, session_id, token_hash, expires_at)
      values (${userId}, 'refresh', ${crypto.randomUUID()}, ${'a'.repeat(64)}, now() + interval '1 day')
      returning id
    `

    await sql`delete from users where id = ${userId}`

    const remaining = await sql`select 1 from user_tokens where id = ${token?.id as string}`
    expect(remaining).toHaveLength(0)
  })

  it('creates the email_logs table', async () => {
    const rows = await sql`
      select column_name from information_schema.columns
      where table_name = 'email_logs'
    `
    const columns = rows.map((r) => r.column_name as string)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'recipient',
        'template_key',
        'status',
        'provider_message_id',
        'error_code',
        'created_at',
      ])
    )
    // No updatedAt, no deletedAt: email_logs is append-only (see email-log.model.ts). Asserted as an absence so a later column addition fails loudly here.
    expect(columns).not.toContain('updated_at')
    expect(columns).not.toContain('deleted_at')
  })

  /**
   * Migration 0006's `email_logs_status_check` backs
   * `$type<EmailLogStatus>()` (compile-time only) with a database-level
   * CHECK, same shape as `user_tokens_purpose_check` above.
   */
  it('rejects an invalid status value at the database level via its CHECK constraint', async () => {
    await expect(
      sql`
        insert into email_logs (recipient, template_key, status)
        values (${'bogus-status@example.test'}, 'password_reset', 'bogus')
      `
    ).rejects.toThrow()

    const remaining = await sql`
      select 1 from email_logs where recipient = ${'bogus-status@example.test'}
    `
    expect(remaining).toHaveLength(0)
  })

  /**
   * Migration 0007's `email_logs_error_code_check` replaced the
   * `varchar(64)` width (`RAW_TOKEN_BYTES` hex-encoded is exactly 64
   * chars, so it fit a raw token perfectly) with an uppercase-only shape
   * CHECK, tested here against lowercase hex — the one alphabet a raw
   * token is ever encoded in.
   */
  it('rejects a lowercase-hex error_code at the database level via its CHECK constraint', async () => {
    const lowercaseHex = 'a1'.repeat(16) // 32 characters — fits the column width exactly
    await expect(
      sql`
        insert into email_logs (recipient, template_key, status, error_code)
        values (${'bogus-error-code@example.test'}, 'password_reset', 'failed', ${lowercaseHex})
      `
    ).rejects.toThrow()

    const remaining = await sql`
      select 1 from email_logs where recipient = ${'bogus-error-code@example.test'}
    `
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
    // runMigrations() closes the pool it uses when it finishes, so this must be the last test: sql/db are module-scope singletons every test above shares.
    await expect(runMigrations()).resolves.toBeUndefined()
  })
})
