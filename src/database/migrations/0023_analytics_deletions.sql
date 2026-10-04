CREATE TABLE "analytics_deletions" (
	"distinct_id" varchar(64) PRIMARY KEY NOT NULL,
	"not_before" timestamp (3) with time zone NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" varchar(200),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_deletions_due_idx" ON "analytics_deletions" USING btree ("not_before");