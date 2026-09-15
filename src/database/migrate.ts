// src/database/migrate.ts
//
// Run from the production image as `node dist/database/migrate.js`, which is
// why drizzle-kit stays a devDependency — it is a build-time tool and never
// ships. Runs to completion and exits; it is not a server.
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDatabase, db } from '@/services/database.service'

/**
 * Apply every pending migration, then close the pool.
 * @returns Resolves when the database is at the latest migration.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: 'src/database/migrations' })
  await closeDatabase()
}

// Only run when this module is executed directly (`pnpm db:migrate`), not
// when `runMigrations` is imported by the test suite's global setup.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMigrations()
}
