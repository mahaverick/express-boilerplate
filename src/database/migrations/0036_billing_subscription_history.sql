CREATE TABLE "tenant_billing_subscriptions" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"mode" varchar(8) NOT NULL,
	"subscription_id" varchar(64) NOT NULL,
	"first_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_subscriptions_subscription_unique" UNIQUE("provider","mode","subscription_id"),
	CONSTRAINT "tenant_billing_subscriptions_provider_check" CHECK ("tenant_billing_subscriptions"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "tenant_billing_subscriptions_mode_check" CHECK ("tenant_billing_subscriptions"."mode" in ('test', 'live'))
);
--> statement-breakpoint
ALTER TABLE "tenant_billing_subscriptions" ADD CONSTRAINT "tenant_billing_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_billing_subscriptions_tenant_seen_idx" ON "tenant_billing_subscriptions" USING btree ("tenant_id","first_seen_at","id");--> statement-breakpoint
-- Backfill: each workspace's current subscription, and every subscription a charge or activation event resolved to a workspace, first seen at its earliest record.
-- A duplicate checkout the sync refused also has charge events resolved to the workspace; it never became current, and every refund path raises a staff alert naming "duplicate subscription <id>", so an id such an alert names is left out.
INSERT INTO "tenant_billing_subscriptions" ("tenant_id", "provider", "mode", "subscription_id", "first_seen_at")
SELECT "tenant_id", "provider", "mode", "subscription_id", min("at")
FROM (
	SELECT "tenant_id", "provider", "provider_mode" AS "mode", "provider_subscription_id" AS "subscription_id", "updated_at" AS "at"
	FROM "tenant_billing"
	WHERE "provider_subscription_id" IS NOT NULL AND "provider" IS NOT NULL AND "provider_mode" IS NOT NULL
	UNION ALL
	SELECT "tenant_id", "provider", "mode", "subscription_id", "received_at" AS "at"
	FROM "billing_events"
	WHERE "tenant_id" IS NOT NULL AND "subscription_id" IS NOT NULL
		AND "type" IN ('subscription.activated', 'subscription.charged', 'invoice.paid')
		AND NOT EXISTS (
			SELECT 1 FROM "billing_alerts"
			WHERE "billing_alerts"."message" ~* ('duplicate subscription ' || "billing_events"."subscription_id" || '([^A-Za-z0-9_]|$)')
		)
) AS "seen"
GROUP BY "tenant_id", "provider", "mode", "subscription_id"
ORDER BY min("at")
ON CONFLICT DO NOTHING;
