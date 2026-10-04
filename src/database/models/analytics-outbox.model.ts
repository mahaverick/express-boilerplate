/**
 * @file The `analytics_outbox` table: server analytics events waiting to be
 * sent to PostHog. A row is written in the same transaction as the change it
 * describes (or right after commit, for a product event), and leaves the outbox
 * when PostHog acknowledges it, when PostHog has rejected it alone `ANALYTICS_POISON_REJECTIONS` times, when
 * the retention purge drops it, or when a user's purge or the deletion tick
 * removes that user's rows (`deleteForDistinctId`, `deleteForDistinctIds`). It holds ids, never PII, and has no foreign key.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { index, jsonb, pgTable, smallint, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * The `analytics_outbox` table.
 */
export const analyticsOutboxModel = pgTable(
  'analytics_outbox',
  {
    /**
     * Sent as the PostHog event `uuid`, so a resend after a lost ack is
     * deduplicated by PostHog.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    event: varchar('event', { length: 100 }).notNull(),
    /**
     * A user id, or `'system'` for an event no person caused.
     */
    distinctId: varchar('distinct_id', { length: 64 }).notNull(),
    /**
     * Fully built PostHog properties, `$groups` included.
     */
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull(),
    /**
     * Sent as the event `timestamp`.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    /**
     * The drainer's lease: while it is in the future, no other drainer claims the row.
     */
    claimedUntil: timestamp('claimed_until', { withTimezone: true, precision: 3 }),
    /**
     * Claims so far; drives the retry backoff, never deletion.
     */
    attempts: smallint('attempts').notNull().default(0),
    /**
     * Times PostHog refused this row on its own; the drainer deletes it at the poison limit.
     */
    rejections: smallint('rejections').notNull().default(0),
  },
  (table) => [index('analytics_outbox_claim_idx').on(table.claimedUntil, table.occurredAt)]
)

/**
 * An analytics_outbox row as read from the database.
 */
export type AnalyticsOutboxRow = InferSelectModel<typeof analyticsOutboxModel>

/**
 * An analytics_outbox row as written to the database.
 */
export type NewAnalyticsOutboxRow = InferInsertModel<typeof analyticsOutboxModel>
