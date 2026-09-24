DROP INDEX "users_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" is null;