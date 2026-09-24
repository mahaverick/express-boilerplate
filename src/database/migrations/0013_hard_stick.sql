ALTER TABLE "notifications" ADD COLUMN "dedupe_key" varchar(128);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_unique" ON "notifications" USING btree ("dedupe_key");