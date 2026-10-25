CREATE TABLE "billing_alerts" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"tenant_id" varchar(36),
	"message" varchar(280) NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_alerts_kind_check" CHECK ("billing_alerts"."kind" in ('duplicate_refunded', 'webhook_failing', 'reconcile_repair', 'dispute', 'subscription_completed'))
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" varchar(16) NOT NULL,
	"mode" varchar(8) NOT NULL,
	"provider_event_id" varchar(64) NOT NULL,
	"type" varchar(64) NOT NULL,
	"subscription_id" varchar(64),
	"tenant_id" varchar(36),
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" varchar(500),
	CONSTRAINT "billing_events_provider_event_unique" UNIQUE("provider","mode","provider_event_id"),
	CONSTRAINT "billing_events_provider_check" CHECK ("billing_events"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "billing_events_mode_check" CHECK ("billing_events"."mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"trial_enabled" boolean NOT NULL,
	"trial_days" integer NOT NULL,
	"past_due_grace_days" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(36),
	CONSTRAINT "billing_settings_single_row_check" CHECK ("billing_settings"."id" = 1),
	CONSTRAINT "billing_settings_trial_days_check" CHECK ("billing_settings"."trial_days" between 1 and 90),
	CONSTRAINT "billing_settings_grace_days_check" CHECK ("billing_settings"."past_due_grace_days" between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "billing_state_history" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"from_state" varchar(16),
	"to_state" varchar(16) NOT NULL,
	"cause" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_state_history_from_state_check" CHECK ("billing_state_history"."from_state" is null or "billing_state_history"."from_state" in ('trialing', 'free', 'active', 'past_due')),
	CONSTRAINT "billing_state_history_to_state_check" CHECK ("billing_state_history"."to_state" in ('trialing', 'free', 'active', 'past_due')),
	CONSTRAINT "billing_state_history_source_check" CHECK ("billing_state_history"."source" in ('webhook', 'confirm', 'reconcile', 'job', 'staff', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" varchar(16) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" varchar(280),
	"entitlements" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key"),
	CONSTRAINT "plans_key_check" CHECK ("plans"."key" in ('free', 'paid'))
);
--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"currency" char(3) NOT NULL,
	"country" char(2),
	"interval" varchar(8) NOT NULL,
	"amount_minor" integer NOT NULL,
	"provider" varchar(16),
	"provider_mode" varchar(8),
	"provider_plan_id" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "plan_prices_provider_plan_unique" UNIQUE("provider","provider_mode","provider_plan_id"),
	CONSTRAINT "plan_prices_currency_check" CHECK ("plan_prices"."currency" = 'INR'),
	CONSTRAINT "plan_prices_interval_check" CHECK ("plan_prices"."interval" in ('month', 'year')),
	CONSTRAINT "plan_prices_amount_check" CHECK ("plan_prices"."amount_minor" > 0),
	CONSTRAINT "plan_prices_provider_check" CHECK ("plan_prices"."provider" is null or "plan_prices"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "plan_prices_provider_mode_check" CHECK ("plan_prices"."provider_mode" is null or "plan_prices"."provider_mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "tenant_billing" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"state" varchar(16) NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"price_id" varchar(36),
	"trial_started_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"trial_on_owner_accept" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"halted_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"provider" varchar(16),
	"provider_mode" varchar(8),
	"provider_subscription_id" varchar(64),
	"pending_subscription_id" varchar(64),
	"next_subscription_id" varchar(64),
	"next_price_id" varchar(36),
	"payer_user_id" varchar(36),
	"billing_email" varchar(254),
	"checkout_started_by" varchar(36),
	"trial_midpoint_sent_at" timestamp with time zone,
	"trial_reminder_3d_sent_at" timestamp with time zone,
	"trial_reminder_last_day_sent_at" timestamp with time zone,
	"trial_ended_notified_at" timestamp with time zone,
	"renewal_reminder_for_period_end" timestamp with time zone,
	"winback_7d_sent_at" timestamp with time zone,
	"winback_30d_sent_at" timestamp with time zone,
	"lifecycle_cancel_sent_at" timestamp with time zone,
	"dispute_open" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_provider_subscription_id_unique" UNIQUE("provider_subscription_id"),
	CONSTRAINT "tenant_billing_state_check" CHECK ("tenant_billing"."state" in ('trialing', 'free', 'active', 'past_due')),
	CONSTRAINT "tenant_billing_provider_check" CHECK ("tenant_billing"."provider" is null or "tenant_billing"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "tenant_billing_provider_mode_check" CHECK ("tenant_billing"."provider_mode" is null or "tenant_billing"."provider_mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "tenant_entitlement_grants" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" jsonb,
	"reason" varchar(500) NOT NULL,
	"granted_by" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" varchar(36),
	"expired_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upgrade_requests" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"requested_by" varchar(36) NOT NULL,
	"entitlement_key" varchar(64),
	"surface" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_banner_dismissals" (
	"user_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"banner_key" varchar(64) NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_banner_dismissals_user_id_tenant_id_banner_key_pk" PRIMARY KEY("user_id","tenant_id","banner_key")
);
--> statement-breakpoint
CREATE TABLE "user_trials" (
	"user_id" varchar(36) PRIMARY KEY NOT NULL,
	"first_trial_tenant_id" varchar(36),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_state_history" ADD CONSTRAINT "billing_state_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_price_id_plan_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."plan_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_next_price_id_plan_prices_id_fk" FOREIGN KEY ("next_price_id") REFERENCES "public"."plan_prices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_checkout_started_by_users_id_fk" FOREIGN KEY ("checkout_started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_entitlement_grants" ADD CONSTRAINT "tenant_entitlement_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_entitlement_grants" ADD CONSTRAINT "tenant_entitlement_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_entitlement_grants" ADD CONSTRAINT "tenant_entitlement_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade_requests" ADD CONSTRAINT "upgrade_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade_requests" ADD CONSTRAINT "upgrade_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_banner_dismissals" ADD CONSTRAINT "user_banner_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_banner_dismissals" ADD CONSTRAINT "user_banner_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_trials" ADD CONSTRAINT "user_trials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_trials" ADD CONSTRAINT "user_trials_first_trial_tenant_id_tenants_id_fk" FOREIGN KEY ("first_trial_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_alerts_at_idx" ON "billing_alerts" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "billing_events_tenant_received_idx" ON "billing_events" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "billing_state_history_tenant_at_idx" ON "billing_state_history" USING btree ("tenant_id","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_prices_active_unique" ON "plan_prices" USING btree ("plan_id","currency",coalesce("country", ''),"interval") WHERE "plan_prices"."active";--> statement-breakpoint
CREATE INDEX "tenant_billing_state_idx" ON "tenant_billing" USING btree ("state");--> statement-breakpoint
CREATE INDEX "tenant_billing_trial_ends_idx" ON "tenant_billing" USING btree ("trial_ends_at") WHERE "tenant_billing"."state" = 'trialing';--> statement-breakpoint
CREATE INDEX "tenant_billing_period_end_idx" ON "tenant_billing" USING btree ("current_period_end") WHERE "tenant_billing"."state" in ('active', 'past_due');--> statement-breakpoint
CREATE INDEX "tenant_entitlement_grants_live_idx" ON "tenant_entitlement_grants" USING btree ("tenant_id") WHERE "tenant_entitlement_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "upgrade_requests_open_unique" ON "upgrade_requests" USING btree ("tenant_id","requested_by") WHERE "upgrade_requests"."fulfilled_at" is null;--> statement-breakpoint
-- Hand-added: the two plans. A key the registry knows and a plan omits reads as the registry default.
INSERT INTO "plans" ("key", "name", "entitlements", "sort_order") VALUES
	('free', 'Free', '{"members": 3, "advanced_example": false}'::jsonb, 0),
	('paid', 'Paid', '{"members": null, "advanced_example": true}'::jsonb, 1);--> statement-breakpoint
-- Hand-added: Paid's monthly and yearly INR prices, tax included. The provider plan ids are filled at the first checkout.
INSERT INTO "plan_prices" ("plan_id", "currency", "interval", "amount_minor")
	SELECT "id", 'INR', "price"."interval", "price"."amount_minor"
	FROM "plans", (VALUES ('month', 99900), ('year', 999000)) AS "price" ("interval", "amount_minor")
	WHERE "plans"."key" = 'paid';--> statement-breakpoint
-- Hand-added: the single billing settings row: a 14-day trial and a 7-day grace.
INSERT INTO "billing_settings" ("id", "trial_enabled", "trial_days", "past_due_grace_days") VALUES (1, true, 14, 7);--> statement-breakpoint
-- Hand-added: every customer workspace, archived and soft-deleted ones too, starts on Free. The platform tenant gets no row.
INSERT INTO "tenant_billing" ("tenant_id", "state", "plan_id")
	SELECT "tenants"."id", 'free', (SELECT "id" FROM "plans" WHERE "key" = 'free')
	FROM "tenants" WHERE NOT "tenants"."is_platform";--> statement-breakpoint
-- Hand-ordered: the audit target-type CHECK is swapped last, after the backfill.
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_type_check";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" is null or "audit_logs"."target_type" in ('tenant', 'membership', 'invitation', 'settings', 'user', 'email_message', 'email_suppression', 'platform', 'plan', 'billing'));
