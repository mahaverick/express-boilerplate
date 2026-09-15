ALTER TABLE "user_tokens" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tokens" ALTER COLUMN "session_started_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_tokens" ALTER COLUMN "session_started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD COLUMN "purpose" varchar(20) DEFAULT 'refresh' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD COLUMN "consumed_at" timestamp with time zone;