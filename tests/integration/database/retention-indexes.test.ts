// tests/integration/database/retention-indexes.test.ts
//
// Each retention predicate has an index that can serve it. With sequential
// scans disabled for one transaction, the planner takes an index whenever
// one applies, so the index's name in the plan proves it is usable. The
// predicates are the repositories' purge predicates, written out as SQL.
// tenant_invitations has no index on purpose (see its repository method).
import { describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'

const CUTOFF = `'2001-01-01T00:00:00.000Z'::timestamptz`
const TOKEN_PREDICATE = `expires_at < ${CUTOFF} or (revoked_at < ${CUTOFF} and consumed_at is null)`

/**
 * The text plan for `query`, with sequential scans off.
 * @param query - A SELECT with no parameters.
 * @returns The plan's lines, joined.
 */
async function planFor(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`
    const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain ${query}`)
    return rows.map((row) => row['QUERY PLAN']).join('\n')
  })
}

describe('retention indexes', () => {
  it.each([
    [
      'email_logs_created_at_idx',
      `select id from email_logs where created_at < ${CUTOFF} limit 5000`,
    ],
    [
      'notifications_read_at_idx',
      `select id from notifications where read_at < ${CUTOFF} limit 5000`,
    ],
    [
      'notifications_unread_created_idx',
      `select id from notifications where read_at is null and created_at < ${CUTOFF} limit 5000`,
    ],
    [
      'audit_logs_occurred_idx',
      `select id from audit_logs where occurred_at < ${CUTOFF} limit 5000`,
    ],
    [
      'user_tokens_expires_at_idx',
      `select id from user_tokens where ${TOKEN_PREDICATE} limit 5000`,
    ],
    [
      'user_tokens_revoked_unconsumed_idx',
      `select id from user_tokens where ${TOKEN_PREDICATE} limit 5000`,
    ],
    // The NOT EXISTS probe, and the check the replaced_by_id foreign key runs on delete.
    [
      'user_tokens_replaced_by_id_idx',
      `select 1 from user_tokens where replaced_by_id = '00000000-0000-0000-0000-000000000000'`,
    ],
  ])('%s serves its purge predicate', async (index, query) => {
    expect(await planFor(query)).toContain(index)
  })
})
