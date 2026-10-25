ALTER TABLE "tenant_billing" ADD COLUMN "cancel_marker_subscription_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "cancel_marker_by" varchar(8);--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "cancel_marker_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "cancel_marker_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_cancel_marker_user_id_users_id_fk" FOREIGN KEY ("cancel_marker_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_cancel_marker_by_check" CHECK ("tenant_billing"."cancel_marker_by" is null or "tenant_billing"."cancel_marker_by" in ('owner', 'staff'));