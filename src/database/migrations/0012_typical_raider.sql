CREATE TABLE "tenants" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" varchar(1000),
	"logo" varchar(255),
	"website" varchar(255),
	"lifecycle_state" varchar(20) DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_lifecycle_state_check" CHECK ("tenants"."lifecycle_state" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"metadata" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memberships" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_memberships_role_check" CHECK ("user_memberships"."role" in ('owner', 'admin', 'manager', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug") WHERE "tenants"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_memberships_user_id_tenant_id_unique" ON "user_memberships" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "user_memberships_tenant_id_idx" ON "user_memberships" USING btree ("tenant_id");