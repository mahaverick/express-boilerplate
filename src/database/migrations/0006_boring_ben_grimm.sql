CREATE TABLE "email_logs" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"template_key" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"provider_message_id" varchar(255),
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_logs_status_check" CHECK ("email_logs"."status" in ('sent', 'failed'))
);
