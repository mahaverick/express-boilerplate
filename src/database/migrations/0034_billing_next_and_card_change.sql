ALTER TABLE "tenant_billing" ADD COLUMN "next_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "card_change_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD COLUMN "card_change_started_by" varchar(36);--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_card_change_started_by_users_id_fk" FOREIGN KEY ("card_change_started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;