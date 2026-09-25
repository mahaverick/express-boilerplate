// tests/unit/errors/postgres-errors.test.ts
//
// isUniqueViolation's own behaviour needs no database — pure logic over
// constructed error objects, same reasoning tests/unit/validators/
// parse.validators.test.ts gives for living under tests/unit/.
import { DrizzleQueryError } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from '@/errors/postgres-errors'

/**
 * Build a real `postgres.PostgresError`, typed correctly for callers.
 * `postgres`'s own type declarations give `PostgresError` no explicit
 * constructor, so it inherits `Error`'s `(message?: string)` — this
 * builds one through that signature, then attaches the fields
 * `isUniqueViolation` reads, exactly as the runtime class itself does
 * (`Object.assign(this, x)`, `node_modules/postgres/src/errors.js`).
 * @param properties - The message and the fields `isUniqueViolation` reads off a real driver error.
 * @param properties.message - The driver's error message.
 * @param properties.code - The Postgres `SQLSTATE` code.
 * @param properties.constraint_name - The violated constraint's name, when the code is a unique violation.
 * @returns A `postgres.PostgresError` instance.
 */
function pgError(properties: {
  message: string
  code: string
  constraint_name?: string
}): postgres.PostgresError {
  return Object.assign(new postgres.PostgresError(properties.message), properties)
}

describe('isUniqueViolation', () => {
  it('is true for a direct postgres.PostgresError with code 23505', () => {
    const error = pgError({
      message: 'duplicate key value violates unique constraint "tenants_slug_unique"',
      code: '23505',
      constraint_name: 'tenants_slug_unique',
    })
    expect(isUniqueViolation(error)).toBe(true)
  })

  it('is true for a DrizzleQueryError wrapping a 23505 PostgresError in .cause', () => {
    const cause = pgError({
      message: 'duplicate key value violates unique constraint "tenants_slug_unique"',
      code: '23505',
      constraint_name: 'tenants_slug_unique',
    })
    const error = new DrizzleQueryError(
      'insert into "tenants" ("slug") values ($1)',
      ['acme'],
      cause
    )
    expect(isUniqueViolation(error)).toBe(true)
  })

  it('is false for a PostgresError with a different SQLSTATE code', () => {
    const error = pgError({
      message: 'value too long for type character varying(320)',
      code: '22001',
    })
    expect(isUniqueViolation(error)).toBe(false)
  })

  it('is false for a plain Error that merely carries a matching code property, unwrapped', () => {
    const error = Object.assign(new Error('looks like a violation'), { code: '23505' })
    expect(isUniqueViolation(error)).toBe(false)
  })

  it('is true when constraintName is given and matches the violated constraint', () => {
    const error = pgError({
      message: 'duplicate key value violates unique constraint "tenant_invitations_pending_unique"',
      code: '23505',
      constraint_name: 'tenant_invitations_pending_unique',
    })
    expect(isUniqueViolation(error, 'tenant_invitations_pending_unique')).toBe(true)
  })

  it('is false when constraintName is given but a different constraint was violated', () => {
    const error = pgError({
      message: 'duplicate key value violates unique constraint "tenants_slug_unique"',
      code: '23505',
      constraint_name: 'tenants_slug_unique',
    })
    expect(isUniqueViolation(error, 'tenant_invitations_pending_unique')).toBe(false)
  })

  it('ignores constraint_name and matches any unique violation when constraintName is omitted', () => {
    const error = pgError({
      message:
        'duplicate key value violates unique constraint "auth_providers_provider_provider_id_unique"',
      code: '23505',
      constraint_name: 'auth_providers_provider_provider_id_unique',
    })
    expect(isUniqueViolation(error)).toBe(true)
  })
})
