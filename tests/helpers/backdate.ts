/**
 * @file Moves a row's timestamps into the past: `updated_at`, so a later
 * update's timestamp cannot tie it (a create and its following update can
 * land in the same millisecond, the finest grain a JS `Date` keeps), and an
 * invitation's `last_sent_at`, so a resend is past its cooldown.
 */
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
  // drizzle(sql) installs identity parsers on the shared client, so this raw query gets updated_at back as text, not a Date.
  const [row] = await sql<{ updated_at: string }[]>`
    update ${sql(table)} set updated_at = updated_at - interval '1 second'
    where ${sql(key.column)} = ${key.value}
    returning updated_at
  `
  if (!row) throw new Error(`backdateUpdatedAt: no ${table} row where ${key.column} = ${key.value}`)
  return new Date(row.updated_at)
}

/**
 * Move an invitation's last send a day into the past, beyond any resend cooldown.
 * @param invitationId - The invitation.
 * @throws {Error} When no invitation has that id.
 */
export async function backdateInvitationSend(invitationId: string): Promise<void> {
  const rows = await sql`
    update tenant_invitations set last_sent_at = now() - interval '1 day'
    where id = ${invitationId}
    returning id
  `
  if (rows.length === 0) throw new Error(`backdateInvitationSend: no invitation ${invitationId}`)
}
