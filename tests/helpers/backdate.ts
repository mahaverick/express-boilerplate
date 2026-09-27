// tests/helpers/backdate.ts
//
// A create and the update after it can land in the same millisecond, and a
// JS Date keeps only milliseconds. Moving updated_at back first gives "the
// update bumped updatedAt" a strict `>` that cannot tie.
import { sql } from '@/services/database.service'

type BackdatableTable = 'users' | 'tenants' | 'tenant_settings' | 'user_memberships'

/**
 * Move one row's updated_at one second into the past.
 * @param table - The table holding the row.
 * @param key - The row's key column and its value.
 * @param key.column - The key column: `id`, or `tenant_id` for tenant_settings.
 * @param key.value - The key value.
 * @returns The row's new updated_at: the baseline an update must exceed.
 * @throws {Error} When no row matches the key.
 */
export async function backdateUpdatedAt(
  table: BackdatableTable,
  key: { column: 'id' | 'tenant_id'; value: string }
): Promise<Date> {
  // The shared client's own timestamp parsers are identity (drizzle does
  // that mapping itself), so a raw query gets the column back as text.
  const [row] = await sql<{ updated_at: string }[]>`
    update ${sql(table)} set updated_at = updated_at - interval '1 second'
    where ${sql(key.column)} = ${key.value}
    returning updated_at
  `
  if (!row) throw new Error(`backdateUpdatedAt: no ${table} row where ${key.column} = ${key.value}`)
  return new Date(row.updated_at)
}
