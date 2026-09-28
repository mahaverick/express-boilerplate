/**
 * @file The migration runner, run from the production image as
 * `node dist/database/migrate.js` or by `pnpm db:migrate`. It reads only
 * `DATABASE_URL` (`getDatabaseUrl()`) and opens its own short-lived
 * connection, never database.service.ts's pool, so it needs none of the
 * app's secrets.
 */
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getDatabaseUrl } from '@/configs/env.config'

/**
 * Resolved next to this module, not from `process.cwd()`, so `tsx` from the
 * repo root and `node dist/database/migrate.js` from any directory both find it.
 */
const migrationsFolder = `${import.meta.dirname}/migrations`

/**
 * Apply every pending migration against a short-lived connection, then close
 * it. Defaults to `DATABASE_URL`; accepts an explicit URL so the test
 * suite's global setup can migrate more than one database from one process.
 * @param databaseUrl - The database to migrate. Defaults to `getDatabaseUrl()`.
 * @returns Resolves when the database is at the latest migration.
 */
export async function runMigrations(databaseUrl: string = getDatabaseUrl()): Promise<void> {
  // Drops the "already exists, skipping" NOTICEs the migrator's bookkeeping DDL raises every run.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end({ timeout: 5 })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMigrations()
}
