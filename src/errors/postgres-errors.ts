// src/errors/postgres-errors.ts
//
// One unique-violation check for every repository, optionally scoped to
// one constraint name.
import { DrizzleQueryError } from 'drizzle-orm'
import postgres from 'postgres'

// Postgres error code for a unique-constraint violation.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION_CODE = '23505'

/**
 * Whether an error (or its Drizzle-wrapped cause) is a Postgres unique
 * violation (23505), optionally scoped to one named constraint.
 * @param error - The error thrown by a write.
 * @param constraintName - When given, only a violation of this exact constraint counts; omit to match any unique violation.
 * @returns True when error is (or wraps) a 23505 unique violation, and — when constraintName is given — the violated constraint matches it.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  if (!(cause instanceof postgres.PostgresError) || cause.code !== UNIQUE_VIOLATION_CODE) {
    return false
  }
  return constraintName === undefined || cause.constraint_name === constraintName
}
