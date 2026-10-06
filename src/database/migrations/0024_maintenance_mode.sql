CREATE TABLE "maintenance_mode_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"message" text,
	"reason" text,
	"changed_by" varchar(36),
	"changed_at" timestamp (3) with time zone NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "maintenance_mode_state_single_row_check" CHECK ("maintenance_mode_state"."id" = 1),
	CONSTRAINT "maintenance_mode_state_mode_check" CHECK ("maintenance_mode_state"."mode" in ('off', 'read_only', 'full')),
	CONSTRAINT "maintenance_mode_state_message_check" CHECK (("maintenance_mode_state"."mode" = 'off' or "maintenance_mode_state"."message" is not null) and char_length("maintenance_mode_state"."message") <= 500),
	CONSTRAINT "maintenance_mode_state_reason_check" CHECK (char_length("maintenance_mode_state"."reason") <= 500),
	CONSTRAINT "maintenance_mode_state_version_check" CHECK ("maintenance_mode_state"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_type_check";--> statement-breakpoint
ALTER TABLE "maintenance_mode_state" ADD CONSTRAINT "maintenance_mode_state_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" is null or "audit_logs"."target_type" in ('tenant', 'membership', 'invitation', 'settings', 'user', 'email_message', 'email_suppression', 'platform'));--> statement-breakpoint
INSERT INTO "maintenance_mode_state" ("id", "mode", "message", "reason", "changed_by", "changed_at", "version") VALUES (1, 'off', NULL, NULL, NULL, now(), 0);
