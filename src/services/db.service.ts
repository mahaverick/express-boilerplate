import 'dotenv/config'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { DATABASE_URL } from '@/configs/constants/constants'
import * as schema from '@/database/schema'

const client = postgres(DATABASE_URL, { max: 1 })

const db = drizzle(client, { schema, logger: true })

export default db
