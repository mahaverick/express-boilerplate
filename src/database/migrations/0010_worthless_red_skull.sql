CREATE TABLE "auth_providers" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_providers_provider_check" CHECK ("auth_providers"."provider" in ('email', 'google'))
);
--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_providers_provider_provider_id_unique" ON "auth_providers" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "auth_providers_user_id_idx" ON "auth_providers" USING btree ("user_id");--> statement-breakpoint
-- Data migration, not a schema diff — drizzle-kit only generates the
-- CREATE TABLE/index/FK statements above; this INSERT is added by hand
-- (see docs/superpowers/plans/2026-09-17-google-oauth.md, Task 1 Step 3).
-- Backfills an 'email' auth_providers row for every
-- pre-existing password-based user, so this table's invariant ("a
-- password-based user has an 'email' row" — see auth-provider.model.ts's
-- own header comment) holds for accounts that existed before this table
-- did, not just ones created after. `password_hash IS NOT NULL` is the
-- same test user.model.ts's own header comment uses to distinguish a
-- password-based user from a federated-only one (nullable `password_hash`
-- — plan B4). Placed after the unique index above (not merely after the
-- CREATE TABLE) so the constraint this INSERT must not violate already
-- exists when it runs; in practice it can't collide regardless, since
-- `users_email_unique` already guarantees no two users share an email.
-- Uses `email` verbatim as `providerId`, matching whatever case it was
-- stored in — same value `register()` will insert going forward (Task 4).
INSERT INTO "auth_providers" ("id", "user_id", "provider", "provider_id", "created_at", "updated_at")
SELECT uuidv7(), "id", 'email', "email", now(), now()
FROM "users"
WHERE "password_hash" IS NOT NULL;