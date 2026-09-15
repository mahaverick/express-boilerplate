// src/database/migrate.ts
//
// Run from the production image as `node dist/database/migrate.js`, which is
// why drizzle-kit stays a devDependency — it is a build-time tool and never
// ships. Runs to completion and exits; it is not a server.
//
// Deliberately does NOT import `db`/`sql` from `@/services/database.service`.
// That module's module-scope `getEnv()` validates the entire application
// schema — JWT secrets, session secret, all of it — which has nothing to do
// with applying SQL migrations. `drizzle.config.ts` solved this identically
// for drizzle-kit's own generate/migrate/check commands via
// `getDatabaseUrl()` (`EnvSchema.pick({ DATABASE_URL: true })`, the same
// field rule, single-sourced); this runner uses the same function and opens
// its own short-lived connection instead, so `db:migrate`/`db:migrate:prod`
// need only `DATABASE_URL` — verified empirically: with only `DATABASE_URL`
// set (no `.env`, no JWT/session secrets), `pnpm db:migrate` succeeds.
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getDatabaseUrl } from '@/configs/env.config'

// Resolved relative to THIS module (`import.meta.dirname`), not
// process.cwd(). `pnpm db:migrate` (tsx, cwd at the repo root) and
// `node dist/database/migrate.js` (a deploy image, possibly launched from
// any working directory) must both find the migrations directory next to
// wherever this file itself actually lives — 'src/database/migrations' as a
// cwd-relative literal only ever resolved for the former.
const migrationsFolder = `${import.meta.dirname}/migrations`

/**
 * Apply every pending migration against a short-lived connection, then close
 * it. Defaults to `DATABASE_URL`; accepts an explicit URL so the test
 * suite's global setup can migrate more than one database from one process.
 * @param databaseUrl - The database to migrate. Defaults to `getDatabaseUrl()`.
 * @returns Resolves when the database is at the latest migration.
 */
export async function runMigrations(databaseUrl: string = getDatabaseUrl()): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end({ timeout: 5 })
  }
}

// Only run when this module is executed directly (`pnpm db:migrate`), not
// when `runMigrations` is imported by the test suite's global setup.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMigrations()
}
