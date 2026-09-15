// src/services/database.service.ts
//
// One postgres client for the process. `postgres` pools internally, so a
// second client means a second pool and double the configured connection
// budget — which only shows up under load, as "too many connections".
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getEnv } from '@/configs/env.config'

const env = getEnv()

/**
 * Raw SQL client. Prefer `db` unless you need untyped SQL.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'test' ? 2 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Transaction pooling breaks prepared statements; off is the portable default.
  prepare: false,
})

/**
 * Drizzle client. The query interface every repository uses.
 */
export const db = drizzle(sql)

/**
 * Check that the database answers.
 * @returns True when a trivial query succeeds.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await sql`select 1`
    return true
  } catch {
    return false
  }
}

/**
 * Close the pool. Called by graceful shutdown; safe to call twice.
 * @returns Resolves once the pool is drained.
 */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 })
}
