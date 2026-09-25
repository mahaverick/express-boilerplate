// src/services/database.service.ts
//
// One postgres client for the process. `postgres` pools internally, so a
// second client means a second pool and double the configured connection
// budget — which only shows up under load, as "too many connections".
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { databaseClientOptions } from '@/configs/database.config'
import { getEnv } from '@/configs/env.config'

const env = getEnv()

/**
 * Raw SQL client. Prefer `db` unless you need untyped SQL.
 */
export const sql = postgres(env.DATABASE_URL, databaseClientOptions(env))

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

/**
 * A transaction handle from `db.transaction`, derived from the installed
 * driver so it can never drift from what drizzle actually passes.
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Anything a repository method can run a query on: the pool, or a
 * transaction. Repository methods take it as an optional last parameter
 * defaulting to `db`, so a service can compose several calls atomically.
 */
export type DbExecutor = typeof db | DbTransaction
