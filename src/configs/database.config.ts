/**
 * @file The postgres.js pool options, as a pure function of the validated
 * environment. migrate.ts and the test global setup build their own clients
 * without these, so a statement timeout never cuts a migration short.
 */
import type { Env } from '@/configs/env.config'

/**
 * The postgres.js options for the process-wide pool.
 */
export interface DatabaseClientOptions {
  max: number
  idle_timeout: number
  connect_timeout: number
  prepare: boolean
  connection?: { statement_timeout: number }
}

/**
 * Build the postgres.js pool options from the validated environment.
 * @param env - The database slice of the validated environment.
 * @returns Options for `postgres(url, options)`.
 */
export function databaseClientOptions(
  env: Pick<Env, 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS'>
): DatabaseClientOptions {
  return {
    max: env.DB_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transaction pooling breaks prepared statements; off is the portable default.
    prepare: false,
    // A startup parameter, so every pooled connection gets it.
    ...(env.DB_STATEMENT_TIMEOUT_MS > 0 && {
      connection: { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
    }),
  }
}
