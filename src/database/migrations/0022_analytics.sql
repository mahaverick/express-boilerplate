CREATE TABLE "analytics_outbox" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event" varchar(100) NOT NULL,
	"distinct_id" varchar(64) NOT NULL,
	"properties" jsonb NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp (3) with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"rejections" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "analytics_outbox_claim_idx" ON "analytics_outbox" USING btree ("claimed_until","occurred_at");