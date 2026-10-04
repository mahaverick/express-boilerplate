/**
 * @file The `analytics_deletions` table: one row per purged user whose
 * PostHog person, events and recordings are still to be deleted. The purge
 * writes the row in its own transaction, and the `analytics-deletions` job
 * deletes it once PostHog has queued the deletion. Like the outbox it holds
 * an id and no PII, and has no foreign key: the user row is gone by the
 * time the purge commits. Rows are never pruned.
 */
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { index, pgTable, smallint, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * The `analytics_deletions` table.
 */
export const analyticsDeletionModel = pgTable(
  'analytics_deletions',
  {
    /**
     * The purged user's id, which is their PostHog `distinct_id`.
     */
    distinctId: varchar('distinct_id', { length: 64 }).primaryKey(),
    /**
     * The row is not sent before this instant: an hour after the purge, so
     * events already on their way to PostHog are ingested and deleted with
     * the person. A claim moves it forward by the lease, and a failure by the
     * backoff.
     */
    notBefore: timestamp('not_before', { withTimezone: true, precision: 3 }).notNull(),
    /**
     * Failed deletion requests so far; drives the backoff, never deletion.
     */
    attempts: smallint('attempts').notNull().default(0),
    /**
     * The last failure: an HTTP status or an error class, never a response body.
     */
    lastError: varchar('last_error', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index('analytics_deletions_due_idx').on(table.notBefore)]
)

/**
 * An analytics_deletions row as read from the database.
 */
export type AnalyticsDeletionRow = InferSelectModel<typeof analyticsDeletionModel>

/**
 * An analytics_deletions row as written to the database.
 */
export type NewAnalyticsDeletionRow = InferInsertModel<typeof analyticsDeletionModel>
