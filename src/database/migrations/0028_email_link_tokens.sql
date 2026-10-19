CREATE TABLE "email_link_tokens" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"intent" varchar(16) NOT NULL,
	"app" varchar(8) NOT NULL,
	"email" varchar(320) NOT NULL,
	"user_id" varchar(36),
	"session_id" varchar(36),
	"redirect" varchar(2048),
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_link_tokens_intent_check" CHECK ("email_link_tokens"."intent" in ('sign_in', 'step_up')),
	CONSTRAINT "email_link_tokens_app_check" CHECK ("email_link_tokens"."app" in ('web', 'apex')),
	CONSTRAINT "email_link_tokens_token_hash_check" CHECK ("email_link_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_link_tokens_shape_check" CHECK (("email_link_tokens"."intent" = 'sign_in' and "email_link_tokens"."user_id" is null and "email_link_tokens"."session_id" is null) or ("email_link_tokens"."intent" = 'step_up' and "email_link_tokens"."user_id" is not null and "email_link_tokens"."session_id" is not null and "email_link_tokens"."redirect" is null))
);
--> statement-breakpoint
ALTER TABLE "email_link_tokens" ADD CONSTRAINT "email_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_link_tokens_token_hash_unique" ON "email_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_link_tokens_live_email_idx" ON "email_link_tokens" USING btree ("email","intent") WHERE "email_link_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "email_link_tokens_user_session_idx" ON "email_link_tokens" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "email_link_tokens_expires_at_idx" ON "email_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_link_tokens_revoked_unconsumed_idx" ON "email_link_tokens" USING btree ("revoked_at") WHERE "email_link_tokens"."revoked_at" is not null and "email_link_tokens"."consumed_at" is null;