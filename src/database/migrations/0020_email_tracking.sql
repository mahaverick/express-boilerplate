CREATE TABLE "email_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"type" varchar(16) NOT NULL,
	"bounce_kind" varchar(8),
	"detail" varchar(32),
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_events_provider_event_unique" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "email_events_type_check" CHECK ("email_events"."type" in ('delivered', 'deferred', 'bounced', 'complained', 'opened', 'clicked', 'failed')),
	CONSTRAINT "email_events_bounce_kind_check" CHECK ("email_events"."bounce_kind" in ('hard', 'soft')),
	CONSTRAINT "email_events_bounce_kind_presence_check" CHECK (("email_events"."bounce_kind" is not null) = ("email_events"."type" = 'bounced')),
	CONSTRAINT "email_events_detail_check" CHECK ("email_events"."detail" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"template_key" varchar(32) NOT NULL,
	"user_id" varchar(36),
	"tenant_id" varchar(36),
	"invitation_id" varchar(36),
	"link_app" varchar(8),
	"sender_class" varchar(16) NOT NULL,
	"message_id_header" varchar(255) NOT NULL,
	"job_key" varchar(128),
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"failure_origin" varchar(16),
	"status_updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resent_from_id" varchar(36),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_message_id_header_unique" UNIQUE("message_id_header"),
	CONSTRAINT "email_messages_job_key_unique" UNIQUE("job_key"),
	CONSTRAINT "email_messages_status_check" CHECK ("email_messages"."status" in ('queued', 'sent', 'deferred', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
	CONSTRAINT "email_messages_sender_class_check" CHECK ("email_messages"."sender_class" in ('transactional', 'general')),
	CONSTRAINT "email_messages_link_app_check" CHECK ("email_messages"."link_app" in ('web', 'apex')),
	CONSTRAINT "email_messages_failure_origin_check" CHECK ("email_messages"."failure_origin" in ('send', 'provider', 'enqueue'))
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"address" varchar(320) NOT NULL,
	"reason" varchar(16) NOT NULL,
	"source_event_id" varchar(36),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp (3) with time zone,
	"lifted_by" varchar(36),
	"lift_reason" varchar(500),
	CONSTRAINT "email_suppressions_reason_check" CHECK ("email_suppressions"."reason" in ('hard_bounce', 'complaint')),
	CONSTRAINT "email_suppressions_address_lower_check" CHECK ("email_suppressions"."address" = lower("email_suppressions"."address"))
);
--> statement-breakpoint
ALTER TABLE "email_logs" ADD COLUMN "message_id" varchar(36);--> statement-breakpoint
-- Hand-added: one email_messages row per legacy email_logs row, reusing the
-- attempt's id, so stats and retention keep each attempt's original day.
-- Legacy attempts cannot be grouped into messages retroactively: a mail that
-- was retried five times becomes five messages.
INSERT INTO "email_messages" ("id", "recipient", "template_key", "sender_class", "message_id_header", "variables", "status", "failure_origin", "status_updated_at", "created_at")
SELECT
  "id",
  "recipient",
  "template_key",
  CASE WHEN "template_key" IN ('email_verification', 'password_reset', 'account_setup', 'tenant_invitation') THEN 'transactional' ELSE 'general' END,
  '<legacy-' || "id" || '@invalid>',
  '{}'::jsonb,
  "status",
  CASE WHEN "status" = 'failed' THEN 'send' END,
  "created_at",
  "created_at"
FROM "email_logs"
WHERE "message_id" IS NULL;--> statement-breakpoint
-- Hand-added: point each legacy attempt at the message made from it.
UPDATE "email_logs" SET "message_id" = "id" WHERE "message_id" IS NULL;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_resent_from_id_email_messages_id_fk" FOREIGN KEY ("resent_from_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_source_event_id_email_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."email_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_events_message_id_idx" ON "email_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "email_messages_recipient_lower_idx" ON "email_messages" USING btree (lower("recipient"));--> statement-breakpoint
CREATE INDEX "email_messages_user_id_idx" ON "email_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_messages_tenant_id_idx" ON "email_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_messages_resent_from_id_idx" ON "email_messages" USING btree ("resent_from_id");--> statement-breakpoint
CREATE INDEX "email_messages_created_at_idx" ON "email_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_active_address_unique" ON "email_suppressions" USING btree ("address") WHERE "email_suppressions"."lifted_at" is null;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_message_id_idx" ON "email_logs" USING btree ("message_id");--> statement-breakpoint
-- Hand-ordered: the audit target-type CHECK is swapped last, after the backfill.
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_type_check";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" is null or "audit_logs"."target_type" in ('tenant', 'membership', 'invitation', 'settings', 'user', 'email_message', 'email_suppression'));