/**
 * @file Reads and empties `analytics_outbox` in this worker's database, and
 * a stand-in for `AnalyticsOutboxRepository.insertMany` that makes Postgres
 * itself refuse the insert, for tests of the outbox's failure isolation.
 * Analytics is off under `.env.test`; a test that expects rows turns it on
 * by mocking `isAnalyticsEnabled` (see analytics-outbox.service.test.ts).
 */
import { asc } from 'drizzle-orm'
import {
  analyticsOutboxModel,
  type AnalyticsOutboxRow,
  type NewAnalyticsOutboxRow,
} from '@/database/models/analytics-outbox.model'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { db, sql, type DbExecutor } from '@/services/database.service'

/**
 * One more character than `analytics_outbox.event` holds.
 */
const OVERLONG_EVENT = 'x'.repeat(101)

// eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the repository as `this`
const realInsertMany = AnalyticsOutboxRepository.prototype.insertMany

/**
 * Every outbox row, oldest first.
 * @returns The rows.
 */
export async function outboxRows(): Promise<AnalyticsOutboxRow[]> {
  return db
    .select()
    .from(analyticsOutboxModel)
    .orderBy(asc(analyticsOutboxModel.occurredAt), asc(analyticsOutboxModel.id))
}

/**
 * The outbox rows of one event, oldest first.
 * @param event - The event name.
 * @returns The rows.
 */
export async function outboxRowsOf(event: string): Promise<AnalyticsOutboxRow[]> {
  const rows = await outboxRows()
  return rows.filter((row) => row.event === event)
}

/**
 * Empty the outbox.
 * @returns Resolves once it is empty.
 */
export async function clearOutbox(): Promise<void> {
  await sql`delete from analytics_outbox`
}

/**
 * An `insertMany` that sends the real insert with an event name one
 * character too long, so Postgres refuses it (22001) inside whatever
 * transaction or savepoint the caller is in.
 * @param this - The repository.
 * @param rows - The rows the caller built.
 * @param executor - Where the caller asked to insert.
 * @returns Never resolves; Postgres rejects the statement.
 */
export function overlongInsertMany(
  this: AnalyticsOutboxRepository,
  rows: NewAnalyticsOutboxRow[],
  executor?: DbExecutor
): Promise<void> {
  return realInsertMany.call(
    this,
    rows.map((row) => ({ ...row, event: OVERLONG_EVENT })),
    executor
  )
}
