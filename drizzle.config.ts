import path from 'path'

import dotenv from 'dotenv'
import { defineConfig, type Config } from 'drizzle-kit'

dotenv.config()

export default defineConfig({
  schema: path.join(__dirname, 'src/database/schema.ts'),
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL as string,
  },
  verbose: true,
  strict: true,
}) satisfies Config
