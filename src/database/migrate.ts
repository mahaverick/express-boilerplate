import path from 'path'

import { config } from 'dotenv'
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { DATABASE_URL } from '@/configs/constants/constants'

config()

// for migrations
const migrationClient = postgres(DATABASE_URL, { max: 1 })

async function postgresMigrate() {
  try {
    const db: PostgresJsDatabase = drizzle(migrationClient)

    // Migrate
    // eslint-disable-next-line no-console
    console.info(`Migrating...`)
    await migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') })
    // eslint-disable-next-line no-console
    console.info(`Migrating Done!`)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error migrating database: ', error)
  } finally {
    await migrationClient.end()
    process.exit(0)
  }
}

postgresMigrate()
