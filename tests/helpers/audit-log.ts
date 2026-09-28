/**
 * @file Empties `audit_logs` in this worker's own database before a test
 * hard-deletes tenants or users.
 */
import { sql } from '@/services/database.service'

/**
 * Empty audit_logs in this worker's database. Call it before hard-deleting
 * tenants or users: `audit_logs` has RESTRICT foreign keys to `tenants` and
 * `users`, and a trigger rejects every other DELETE, but TRUNCATE fires no
 * row trigger.
 * @returns Resolves once the table is empty.
 */
export async function truncateAuditLogs(): Promise<void> {
  await sql`truncate audit_logs`
}
