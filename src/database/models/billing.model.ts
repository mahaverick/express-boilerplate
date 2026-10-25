/**
 * @file The billing tables: plans and their prices, each customer workspace's
 * billing record, trials, staff grants, the settings singleton, provider
 * events, the subscriptions each workspace has held, state history, upgrade
 * requests, banner dismissals and staff alerts. Migration 0033 seeds the Free and Paid plans, the two Paid prices
 * and the settings row, and gives every existing customer workspace a Free
 * record. The platform tenant never has a billing record.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  BILLING_ALERT_KINDS,
  BILLING_HISTORY_SOURCES,
  BILLING_INTERVALS,
  BILLING_PROVIDER_MODES,
  BILLING_PROVIDERS,
  BILLING_STATES,
  PLAN_KEYS,
  type BillingAlertKind,
  type BillingHistorySource,
  type BillingInterval,
  type BillingProvider,
  type BillingProviderMode,
  type BillingState,
  type PlanKey,
} from '@/constants/billing.constants'
import type { EntitlementValue } from '@/constants/entitlements.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { sqlValueList } from '@/utilities/sql-value-list.utilities'

/**
 * A provider id (subscription, plan or event) as Razorpay issues it, with room to spare.
 */
const PROVIDER_ID_LENGTH = 64

/**
 * The `plans` table: the two seeded plans. Staff edit a plan's entitlements;
 * no code creates or deletes one.
 */
export const planModel = pgTable(
  'plans',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    key: varchar('key', { length: 16 }).$type<PlanKey>().notNull().unique(),
    name: varchar('name', { length: 64 }).notNull(),
    description: varchar('description', { length: 280 }),
    /**
     * Entitlement key to value. Reads fill a missing key from the registry default.
     */
    entitlements: jsonb('entitlements').$type<Record<string, EntitlementValue>>().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Bumped on every staff edit, so a stale edit is refused.
     */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check('plans_key_check', sql`${table.key} in (${sql.raw(sqlValueList(PLAN_KEYS))})`),
  ]
)

/**
 * The `plan_prices` table: what a plan costs per currency, country and
 * interval. A price change inserts a new row and retires the old one, so a
 * running subscription keeps the price it started on. The provider plan id is
 * filled at the first checkout.
 */
export const planPriceModel = pgTable(
  'plan_prices',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    planId: varchar('plan_id', { length: 36 })
      .notNull()
      .references(() => planModel.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    /**
     * Null is the default price for every country without its own.
     */
    country: char('country', { length: 2 }),
    interval: varchar('interval', { length: 8 }).$type<BillingInterval>().notNull(),
    /**
     * In the currency's minor unit (paise), tax included.
     */
    amountMinor: integer('amount_minor').notNull(),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>(),
    providerMode: varchar('provider_mode', { length: 8 }).$type<BillingProviderMode>(),
    providerPlanId: varchar('provider_plan_id', { length: PROVIDER_ID_LENGTH }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('plan_prices_currency_check', sql`${table.currency} = 'INR'`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'plan_prices_interval_check',
      sql`${table.interval} in (${sql.raw(sqlValueList(BILLING_INTERVALS))})`
    ),
    check('plan_prices_amount_check', sql`${table.amountMinor} > 0`),
    check(
      'plan_prices_provider_check',
      sql`${table.provider} is null or ${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'plan_prices_provider_mode_check',
      sql`${table.providerMode} is null or ${table.providerMode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    // drizzle's uniqueIndex has no nullsNotDistinct, so coalesce makes the no-country price one value.
    uniqueIndex('plan_prices_active_unique')
      .on(table.planId, table.currency, sql`coalesce(${table.country}, '')`, table.interval)
      .where(sql`${table.active}`),
    unique('plan_prices_provider_plan_unique').on(
      table.provider,
      table.providerMode,
      table.providerPlanId
    ),
  ]
)

/**
 * The `tenant_billing` table: one row per customer workspace, holding its
 * billing state, plan, trial, paid period and provider ids. The tenant id is
 * both key and foreign key; the row is deleted with its tenant, and the
 * service refuses to purge a tenant whose subscription is live. Every write
 * is `UPDATE … WHERE version = $n`.
 */
export const tenantBillingModel = pgTable(
  'tenant_billing',
  {
    tenantId: varchar('tenant_id', { length: 36 })
      .primaryKey()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 16 }).$type<BillingState>().notNull(),
    /**
     * The stored plan. A trialing row names Paid; reads derive the plan in force from the state.
     */
    planId: varchar('plan_id', { length: 36 })
      .notNull()
      .references(() => planModel.id, { onDelete: 'restrict' }),
    priceId: varchar('price_id', { length: 36 }).references(() => planPriceModel.id, {
      onDelete: 'restrict',
    }),
    trialStartedAt: timestamp('trial_started_at', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    /**
     * The trial starts when an owner accepts, for a workspace staff created without one.
     */
    trialOnOwnerAccept: boolean('trial_on_owner_accept').notNull().default(false),
    /**
     * The end of the last paid cycle.
     */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    pastDueSince: timestamp('past_due_since', { withTimezone: true }),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>(),
    providerMode: varchar('provider_mode', { length: 8 }).$type<BillingProviderMode>(),
    providerSubscriptionId: varchar('provider_subscription_id', {
      length: PROVIDER_ID_LENGTH,
    }).unique(),
    /**
     * A checkout started and not yet confirmed.
     */
    pendingSubscriptionId: varchar('pending_subscription_id', { length: PROVIDER_ID_LENGTH }),
    /**
     * The subscription a scheduled interval switch moves to.
     */
    nextSubscriptionId: varchar('next_subscription_id', { length: PROVIDER_ID_LENGTH }),
    /**
     * The price a scheduled interval switch moves to.
     */
    nextPriceId: varchar('next_price_id', { length: 36 }).references(() => planPriceModel.id, {
      onDelete: 'restrict',
    }),
    /**
     * When the next subscription was first read authenticated: a scheduled
     * switch or resubscribe shows from then. Null while there is none or it is unpaid.
     */
    nextAuthenticatedAt: timestamp('next_authenticated_at', { withTimezone: true }),
    payerUserId: varchar('payer_user_id', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    billingEmail: varchar('billing_email', { length: 254 }),
    /**
     * Who started the checkout, so a webhook-driven event is attributed to a person.
     */
    checkoutStartedBy: varchar('checkout_started_by', { length: 36 }).references(
      () => userModel.id,
      { onDelete: 'set null' }
    ),
    /**
     * When an owner opened the current subscription for a card change; its
     * confirm is accepted only within the checkout expiry after this.
     */
    cardChangeStartedAt: timestamp('card_change_started_at', { withTimezone: true }),
    /**
     * The owner who opened the card change; only they may confirm it.
     */
    cardChangeStartedBy: varchar('card_change_started_by', { length: 36 }).references(
      () => userModel.id,
      { onDelete: 'set null' }
    ),
    trialMidpointSentAt: timestamp('trial_midpoint_sent_at', { withTimezone: true }),
    trialReminder3dSentAt: timestamp('trial_reminder_3d_sent_at', { withTimezone: true }),
    trialReminderLastDaySentAt: timestamp('trial_reminder_last_day_sent_at', {
      withTimezone: true,
    }),
    trialEndedNotifiedAt: timestamp('trial_ended_notified_at', { withTimezone: true }),
    /**
     * The period end the last renewal reminder was sent for.
     */
    renewalReminderForPeriodEnd: timestamp('renewal_reminder_for_period_end', {
      withTimezone: true,
    }),
    winback7dSentAt: timestamp('winback_7d_sent_at', { withTimezone: true }),
    winback30dSentAt: timestamp('winback_30d_sent_at', { withTimezone: true }),
    /**
     * When the scheduler cancelled the subscription of a suspended or archived workspace.
     */
    lifecycleCancelSentAt: timestamp('lifecycle_cancel_sent_at', { withTimezone: true }),
    /**
     * The cancel an owner or staff member asked for, recorded before the
     * provider is called, so a sync that brings the cancel in first still
     * reads it as theirs: the subscription, who (`owner` or `staff`), the
     * owner, and when. Cleared when the cancel fails or its write lands.
     */
    cancelMarkerSubscriptionId: varchar('cancel_marker_subscription_id', {
      length: PROVIDER_ID_LENGTH,
    }),
    cancelMarkerBy: varchar('cancel_marker_by', { length: 8 }).$type<'owner' | 'staff'>(),
    cancelMarkerUserId: varchar('cancel_marker_user_id', { length: 36 }).references(
      () => userModel.id,
      { onDelete: 'set null' }
    ),
    cancelMarkerAt: timestamp('cancel_marker_at', { withTimezone: true }),
    disputeOpen: boolean('dispute_open').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'tenant_billing_state_check',
      sql`${table.state} in (${sql.raw(sqlValueList(BILLING_STATES))})`
    ),
    check(
      'tenant_billing_cancel_marker_by_check',
      sql`${table.cancelMarkerBy} is null or ${table.cancelMarkerBy} in ('owner', 'staff')`
    ),
    check(
      'tenant_billing_provider_check',
      sql`${table.provider} is null or ${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'tenant_billing_provider_mode_check',
      sql`${table.providerMode} is null or ${table.providerMode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    index('tenant_billing_state_idx').on(table.state),
    index('tenant_billing_trial_ends_idx')
      .on(table.trialEndsAt)
      .where(sql`${table.state} = 'trialing'`),
    index('tenant_billing_period_end_idx')
      .on(table.currentPeriodEnd)
      .where(sql`${table.state} in ('active', 'past_due')`),
  ]
)

/**
 * The `user_trials` table: one row per person who has had a trial, so each
 * person gets one. Claimed with `ON CONFLICT DO NOTHING` before the workspace
 * is created; the workspace id is filled after.
 */
export const userTrialModel = pgTable('user_trials', {
  userId: varchar('user_id', { length: 36 })
    .primaryKey()
    .references(() => userModel.id, { onDelete: 'cascade' }),
  firstTrialTenantId: varchar('first_trial_tenant_id', { length: 36 }).references(
    () => tenantModel.id,
    { onDelete: 'set null' }
  ),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The `tenant_entitlement_grants` table: a staff member's override of one
 * entitlement for one workspace. Rows are kept after they lapse or are
 * revoked, as history.
 */
export const tenantEntitlementGrantModel = pgTable(
  'tenant_entitlement_grants',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    /**
     * The granted value; SQL NULL is a limit with no cap.
     */
    value: jsonb('value').$type<EntitlementValue>(),
    reason: varchar('reason', { length: 500 }).notNull(),
    grantedBy: varchar('granted_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: varchar('revoked_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    expiredNotifiedAt: timestamp('expired_notified_at', { withTimezone: true }),
  },
  (table) => [
    index('tenant_entitlement_grants_live_idx')
      .on(table.tenantId)
      .where(sql`${table.revokedAt} is null`),
  ]
)

/**
 * The `billing_settings` table: the single row of platform-wide trial and
 * grace settings. A CHECK pins `id` to 1; migration 0033 inserts the row and
 * no code inserts or deletes one. A change affects workspaces created after it.
 */
export const billingSettingsModel = pgTable(
  'billing_settings',
  {
    id: smallint('id').primaryKey().default(1),
    trialEnabled: boolean('trial_enabled').notNull(),
    trialDays: integer('trial_days').notNull(),
    pastDueGraceDays: integer('past_due_grace_days').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar('updated_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    check('billing_settings_single_row_check', sql`${table.id} = 1`),
    check('billing_settings_trial_days_check', sql`${table.trialDays} between 1 and 90`),
    check('billing_settings_grace_days_check', sql`${table.pastDueGraceDays} between 1 and 30`),
  ]
)

/**
 * The `billing_events` table: one row per provider webhook event, for
 * deduplication and retries. It holds ids, the type and the outcome only,
 * never the payload body, which carries the payer's contact and card details.
 */
export const billingEventModel = pgTable(
  'billing_events',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>().notNull(),
    mode: varchar('mode', { length: 8 }).$type<BillingProviderMode>().notNull(),
    providerEventId: varchar('provider_event_id', { length: PROVIDER_ID_LENGTH }).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    subscriptionId: varchar('subscription_id', { length: PROVIDER_ID_LENGTH }),
    tenantId: varchar('tenant_id', { length: 36 }).references(() => tenantModel.id, {
      onDelete: 'set null',
    }),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    error: varchar('error', { length: 500 }),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'billing_events_provider_check',
      sql`${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'billing_events_mode_check',
      sql`${table.mode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    unique('billing_events_provider_event_unique').on(
      table.provider,
      table.mode,
      table.providerEventId
    ),
    index('billing_events_tenant_received_idx').on(table.tenantId, table.receivedAt),
  ]
)

/**
 * The `tenant_billing_subscriptions` table: every subscription a workspace
 * has held as its current one, so the invoice list still reaches the
 * invoices of a subscription the row has since replaced. One row per
 * subscription id, written when the id first becomes current, and deleted
 * with the workspace.
 */
export const tenantBillingSubscriptionModel = pgTable(
  'tenant_billing_subscriptions',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>().notNull(),
    mode: varchar('mode', { length: 8 }).$type<BillingProviderMode>().notNull(),
    subscriptionId: varchar('subscription_id', { length: PROVIDER_ID_LENGTH }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'tenant_billing_subscriptions_provider_check',
      sql`${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'tenant_billing_subscriptions_mode_check',
      sql`${table.mode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    unique('tenant_billing_subscriptions_subscription_unique').on(
      table.provider,
      table.mode,
      table.subscriptionId
    ),
    index('tenant_billing_subscriptions_tenant_seen_idx').on(
      table.tenantId,
      table.firstSeenAt,
      table.id
    ),
  ]
)

/**
 * The `billing_state_history` table: one append-only row per billing state
 * change of a workspace, for staff history and the funnel.
 */
export const billingStateHistoryModel = pgTable(
  'billing_state_history',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    /**
     * Null for the row a new workspace starts with.
     */
    fromState: varchar('from_state', { length: 16 }).$type<BillingState>(),
    toState: varchar('to_state', { length: 16 }).$type<BillingState>().notNull(),
    cause: varchar('cause', { length: 32 }).notNull(),
    source: varchar('source', { length: 16 }).$type<BillingHistorySource>().notNull(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'billing_state_history_from_state_check',
      sql`${table.fromState} is null or ${table.fromState} in (${sql.raw(sqlValueList(BILLING_STATES))})`
    ),
    check(
      'billing_state_history_to_state_check',
      sql`${table.toState} in (${sql.raw(sqlValueList(BILLING_STATES))})`
    ),
    check(
      'billing_state_history_source_check',
      sql`${table.source} in (${sql.raw(sqlValueList(BILLING_HISTORY_SOURCES))})`
    ),
    // Ascending: a backward scan serves ORDER BY at DESC, id DESC; DESC NULLS LAST would not.
    index('billing_state_history_tenant_at_idx').on(table.tenantId, table.at, table.id),
  ]
)

/**
 * The `upgrade_requests` table: a member's request that an owner upgrade the
 * workspace. One open request per member and workspace; a request lapses at
 * `expiresAt`.
 */
export const upgradeRequestModel = pgTable(
  'upgrade_requests',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    requestedBy: varchar('requested_by', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    /**
     * The entitlement the member hit, if the request came from a limit or a feature.
     */
    entitlementKey: varchar('entitlement_key', { length: 64 }),
    /**
     * Where in the product the member asked.
     */
    surface: varchar('surface', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('upgrade_requests_open_unique')
      .on(table.tenantId, table.requestedBy)
      .where(sql`${table.fulfilledAt} is null`),
  ]
)

/**
 * The `user_banner_dismissals` table: which dismissible billing banners a
 * member has closed in a workspace.
 */
export const userBannerDismissalModel = pgTable(
  'user_banner_dismissals',
  {
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    bannerKey: varchar('banner_key', { length: 64 }).notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tenantId, table.bannerKey] })]
)

/**
 * The `billing_alerts` table: billing events staff must look at, such as a
 * refunded duplicate charge or a failing webhook.
 */
export const billingAlertModel = pgTable(
  'billing_alerts',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: varchar('kind', { length: 32 }).$type<BillingAlertKind>().notNull(),
    tenantId: varchar('tenant_id', { length: 36 }).references(() => tenantModel.id, {
      onDelete: 'set null',
    }),
    message: varchar('message', { length: 280 }).notNull(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'billing_alerts_kind_check',
      sql`${table.kind} in (${sql.raw(sqlValueList(BILLING_ALERT_KINDS))})`
    ),
    // Ascending: a backward scan serves ORDER BY at DESC, id DESC; DESC NULLS LAST would not.
    index('billing_alerts_at_idx').on(table.at, table.id),
  ]
)

/**
 * A tenant_billing row as read from the database.
 */
export type TenantBillingRecord = InferSelectModel<typeof tenantBillingModel>

/**
 * A tenant_entitlement_grants row as read from the database.
 */
export type EntitlementGrant = InferSelectModel<typeof tenantEntitlementGrantModel>

/**
 * A new `tenant_billing` row.
 */
export type NewTenantBilling = InferInsertModel<typeof tenantBillingModel>

/**
 * A row of `plans`.
 */
export type Plan = InferSelectModel<typeof planModel>

/**
 * A row of `plan_prices`.
 */
export type PlanPrice = InferSelectModel<typeof planPriceModel>

/**
 * A new `plan_prices` row.
 */
export type NewPlanPrice = InferInsertModel<typeof planPriceModel>

/**
 * A new `tenant_entitlement_grants` row.
 */
export type NewEntitlementGrant = InferInsertModel<typeof tenantEntitlementGrantModel>

/**
 * The `billing_settings` row.
 */
export type BillingSettingsRecord = InferSelectModel<typeof billingSettingsModel>

/**
 * A row of `billing_events`.
 */
export type BillingEventRecord = InferSelectModel<typeof billingEventModel>

/**
 * A new `billing_events` row.
 */
export type NewBillingEvent = InferInsertModel<typeof billingEventModel>

/**
 * A new `billing_state_history` row.
 */
export type NewBillingStateHistory = InferInsertModel<typeof billingStateHistoryModel>

/**
 * A row of `billing_state_history`.
 */
export type BillingStateHistoryRecord = InferSelectModel<typeof billingStateHistoryModel>

/**
 * A row of `upgrade_requests`.
 */
export type UpgradeRequest = InferSelectModel<typeof upgradeRequestModel>

/**
 * A new `upgrade_requests` row.
 */
export type NewUpgradeRequest = InferInsertModel<typeof upgradeRequestModel>

/**
 * A row of `billing_alerts`.
 */
export type BillingAlertRecord = InferSelectModel<typeof billingAlertModel>

/**
 * A new `billing_alerts` row.
 */
export type NewBillingAlert = InferInsertModel<typeof billingAlertModel>
