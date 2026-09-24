CREATE TABLE "tenant_invitations" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" varchar(20) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by" varchar(36),
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" varchar(36),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_invitations_role_check" CHECK ("tenant_invitations"."role" in ('owner', 'admin', 'manager', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitations_token_hash_unique" ON "tenant_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitations_pending_unique" ON "tenant_invitations" USING btree ("tenant_id",lower("email")) WHERE "tenant_invitations"."accepted_at" is null and "tenant_invitations"."revoked_at" is null;