// tests/helpers/audit-log.ts
//
// audit_logs has RESTRICT foreign keys to tenants and users, and its trigger
// rejects every DELETE, so a test that hard-deletes tenants or users empties
// the table first. TRUNCATE fires no row trigger; migration 0016 leaves it
// open for this. Each worker has its own database and runs its files one at a
// time, so this never removes another file's rows mid-test.
import { sql } from '@/services/database.service'

/**
 * Empty audit_logs in this worker's database. Call it before hard-deleting
 * tenants or users.
 * @returns Resolves once the table is empty.
 */
export async function truncateAuditLogs(): Promise<void> {
  await sql`truncate audit_logs`
}
