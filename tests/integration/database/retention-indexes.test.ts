/**
 * @file Each retention predicate has an index that can serve it. With
 * sequential scans disabled for one transaction, the planner takes an index
 * whenever one applies, so the index's name in the plan proves it is
 * usable. Where a sibling composite index whose second column is the same
 * timestamp can serve the predicate too (a skip scan), the planner's choice
 * between them on a near-empty table is a tie, so those siblings are dropped
 * inside the transaction, which then rolls back: the named index alone must
 * serve it. The predicates are the repositories' own purge predicates,
 * written out as SQL; `tenant_invitations` has no index on purpose (see its
 * repository method).
 */
import { describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'

const CUTOFF = `'2001-01-01T00:00:00.000Z'::timestamptz`
const TOKEN_PREDICATE = `expires_at < ${CUTOFF} or (revoked_at < ${CUTOFF} and consumed_at is null)`

/**
 * The sibling composites on `audit_logs` that also serve an `occurred_at` range.
 */
const AUDIT_OCCURRED_SIBLINGS = [
  'audit_logs_tenant_occurred_idx',
  'audit_logs_actor_occurred_idx',
  'audit_logs_target_occurred_idx',
]

/**
 * Thrown to roll back the transaction that dropped the hidden indexes.
 */
class RollbackAfterPlan extends Error {
  /**
   * @param plan - The plan captured before the rollback.
   */
  constructor(readonly plan: string) {
    super('rollback after plan')
  }
}

/**
 * The text plan for `query`, with sequential scans off and `hidden` dropped;
 * the transaction always rolls back, so the drops never persist.
 * @param query - A SELECT with no parameters.
 * @param hidden - Indexes to drop for the plan.
 * @returns The plan's lines, joined.
 */
async function planFor(query: string, hidden: readonly string[] = []): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`
      for (const index of hidden) await tx.unsafe(`drop index "${index}"`)
      const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain ${query}`)
      throw new RollbackAfterPlan(rows.map((row) => row['QUERY PLAN']).join('\n'))
    })
  } catch (error) {
    if (error instanceof RollbackAfterPlan) return error.plan
    throw error
  }
  throw new Error('the plan transaction committed')
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
      AUDIT_OCCURRED_SIBLINGS,
    ],
    [
      'user_tokens_expires_at_idx',
      `select id from user_tokens where ${TOKEN_PREDICATE} limit 5000`,
    ],
    [
      'user_tokens_revoked_unconsumed_idx',
      `select id from user_tokens where ${TOKEN_PREDICATE} limit 5000`,
    ],
    [
      'email_messages_created_at_idx',
      `select id from email_messages where created_at < ${CUTOFF} limit 5000`,
    ],
    // The email group's retention finds a message's events and attempts by message_id, as do the cascades.
    [
      'email_events_message_id_idx',
      `select 1 from email_events where message_id = '00000000-0000-0000-0000-000000000000'`,
    ],
    [
      'email_logs_message_id_idx',
      `select 1 from email_logs where message_id = '00000000-0000-0000-0000-000000000000'`,
    ],
    // The lookup the resent_from_id foreign key's ON DELETE SET NULL runs on every message delete.
    [
      'email_messages_resent_from_id_idx',
      `select 1 from email_messages where resent_from_id = '00000000-0000-0000-0000-000000000000'`,
    ],
    // The lookup the replaced_by_id foreign key's ON DELETE SET NULL runs on every delete.
    [
      'user_tokens_replaced_by_id_idx',
      `select 1 from user_tokens where replaced_by_id = '00000000-0000-0000-0000-000000000000'`,
    ],
  ])('%s serves its purge predicate', async (index, query, hidden?: readonly string[]) => {
    expect(await planFor(query, hidden)).toContain(index)
  })

  it('leaves the hidden indexes in place', async () => {
    await planFor('select 1', AUDIT_OCCURRED_SIBLINGS)

    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where indexname = any(${AUDIT_OCCURRED_SIBLINGS})`
    expect(rows).toHaveLength(AUDIT_OCCURRED_SIBLINGS.length)
  })
})
