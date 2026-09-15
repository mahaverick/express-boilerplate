CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" varchar(60),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"active" boolean DEFAULT true NOT NULL,
	"email_verified_at" timestamp with time zone,
	"last_logged_in_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));