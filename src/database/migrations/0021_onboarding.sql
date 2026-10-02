CREATE TABLE "onboarding_completions" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"user_id" varchar(36),
	"step_key" varchar(64) NOT NULL,
	"source" varchar(16) NOT NULL,
	"completed_by" varchar(36),
	"reason" varchar(500),
	"completed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_completions_source_check" CHECK ("onboarding_completions"."source" in ('auto', 'customer', 'staff')),
	CONSTRAINT "onboarding_completions_staff_reason_check" CHECK ("onboarding_completions"."source" <> 'staff' or "onboarding_completions"."reason" is not null),
	CONSTRAINT "onboarding_completions_auto_actor_check" CHECK ("onboarding_completions"."source" <> 'auto' or "onboarding_completions"."completed_by" is null),
	CONSTRAINT "onboarding_completions_step_key_check" CHECK ("onboarding_completions"."step_key" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "onboarding_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "onboarding_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "onboarding_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "onboarding_dismissed_by" varchar(36);--> statement-breakpoint
ALTER TABLE "onboarding_completions" ADD CONSTRAINT "onboarding_completions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_completions" ADD CONSTRAINT "onboarding_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_completions" ADD CONSTRAINT "onboarding_completions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_completions_step_unique" ON "onboarding_completions" USING btree ("tenant_id",coalesce("user_id", ''),"step_key");--> statement-breakpoint
CREATE INDEX "onboarding_completions_user_id_idx" ON "onboarding_completions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "onboarding_completions_completed_by_idx" ON "onboarding_completions" USING btree ("completed_by");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_onboarding_dismissed_by_users_id_fk" FOREIGN KEY ("onboarding_dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_platform_untracked" CHECK (not "tenants"."is_platform" or not "tenants"."onboarding_tracked");