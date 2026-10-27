/**
 * @file Clears the tax tables a test fills, in foreign-key order.
 */
import { sql } from '@/services/database.service'

/**
 * Empty the tax documents, their counters and the held charges in this
 * worker's database. Credit notes go first: `original_document_id` is
 * RESTRICT. Call it in `beforeEach` and `afterEach` of every tax test.
 * @returns Resolves once the tables are empty.
 */
export async function resetTaxDocuments(): Promise<void> {
  await sql`delete from tax_documents where type = 'credit_note'`
  await sql`delete from tax_documents`
  await sql`delete from tax_document_counters`
  await sql`delete from tax_held_charges`
}
