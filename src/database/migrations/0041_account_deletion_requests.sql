CREATE TABLE "account_deletion_requests" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"reason" varchar(500),
	CONSTRAINT "account_deletion_requests_status_check" CHECK ("account_deletion_requests"."status" in ('open', 'completed')),
	CONSTRAINT "account_deletion_requests_completed_at_check" CHECK (("account_deletion_requests"."status" = 'completed') = ("account_deletion_requests"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_requests_open_unique" ON "account_deletion_requests" USING btree ("user_id") WHERE "account_deletion_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "account_deletion_requests_user_id_idx" ON "account_deletion_requests" USING btree ("user_id");