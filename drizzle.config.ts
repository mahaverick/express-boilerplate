// drizzle.config.ts — where drizzle-kit reads schema and writes migrations.
//
// Replaces the Express 4-era file that pointed at schema paths which no
// longer exist. Uses getDatabaseUrl(), not getEnv(): drizzle-kit only needs
// DATABASE_URL, and getEnv() validates the entire schema (JWT/session
// secrets included) — a false dependency that would make every
// `drizzle-kit generate`/`migrate` invocation require secrets that have
// nothing to do with migrations.
import { defineConfig } from 'drizzle-kit'
import { getDatabaseUrl } from '@/configs/env.config'

export default defineConfig({
  schema: './src/database/models/*.model.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: getDatabaseUrl() },
  strict: true,
  verbose: true,
})
