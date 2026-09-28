/**
 * @file Where drizzle-kit reads the schema and writes migrations. It uses
 * `getDatabaseUrl()`, not `getEnv()`, so drizzle-kit needs only DATABASE_URL
 * and none of the app's secrets.
 */
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
