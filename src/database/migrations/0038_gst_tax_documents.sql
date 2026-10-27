CREATE TABLE "tax_document_counters" (
	"type" varchar(16) NOT NULL,
	"financial_year" char(5) NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "tax_document_counters_type_financial_year_pk" PRIMARY KEY("type","financial_year")
);
--> statement-breakpoint
CREATE TABLE "tax_documents" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" varchar(16) NOT NULL,
	"number" varchar(16) NOT NULL,
	"financial_year" char(5) NOT NULL,
	"issued_at" timestamp (3) with time zone NOT NULL,
	"tenant_id" varchar(36),
	"provider" varchar(16) NOT NULL,
	"provider_mode" varchar(8) NOT NULL,
	"payment_id" varchar(64),
	"refund_id" varchar(64),
	"subscription_id" varchar(64),
	"original_document_id" varchar(36),
	"total_minor" integer NOT NULL,
	"taxable_minor" integer NOT NULL,
	"cgst_minor" integer NOT NULL,
	"sgst_minor" integer NOT NULL,
	"igst_minor" integer NOT NULL,
	"supply" varchar(8) NOT NULL,
	"place_of_supply" char(2) NOT NULL,
	"buyer_gstin" varchar(15),
	"snapshot" jsonb NOT NULL,
	"no_tax_reduction" boolean DEFAULT false NOT NULL,
	"reason" varchar(500),
	"created_by" varchar(36),
	CONSTRAINT "tax_documents_number_unique" UNIQUE("type","financial_year","number"),
	CONSTRAINT "tax_documents_type_check" CHECK ("tax_documents"."type" in ('invoice', 'credit_note')),
	CONSTRAINT "tax_documents_provider_check" CHECK ("tax_documents"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "tax_documents_provider_mode_check" CHECK ("tax_documents"."provider_mode" in ('test', 'live')),
	CONSTRAINT "tax_documents_supply_check" CHECK ("tax_documents"."supply" in ('intra', 'inter')),
	CONSTRAINT "tax_documents_total_check" CHECK ("tax_documents"."total_minor" > 0),
	CONSTRAINT "tax_documents_parts_check" CHECK ("tax_documents"."total_minor" = "tax_documents"."taxable_minor" + "tax_documents"."cgst_minor" + "tax_documents"."sgst_minor" + "tax_documents"."igst_minor"),
	CONSTRAINT "tax_documents_invoice_check" CHECK ("tax_documents"."type" <> 'invoice' or ("tax_documents"."payment_id" is not null and "tax_documents"."original_document_id" is null and "tax_documents"."refund_id" is null)),
	CONSTRAINT "tax_documents_credit_note_check" CHECK ("tax_documents"."type" <> 'credit_note' or "tax_documents"."original_document_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "tax_held_charges" (
	"id" varchar(36) PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_mode" varchar(8) NOT NULL,
	"payment_id" varchar(64) NOT NULL,
	"subscription_id" varchar(64),
	"amount_minor" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"held_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(36),
	"resolution" varchar(500),
	CONSTRAINT "tax_held_charges_payment_unique" UNIQUE("provider","provider_mode","payment_id"),
	CONSTRAINT "tax_held_charges_provider_check" CHECK ("tax_held_charges"."provider" in ('razorpay', 'fake')),
	CONSTRAINT "tax_held_charges_provider_mode_check" CHECK ("tax_held_charges"."provider_mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "tenant_tax_details" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"gstin" varchar(15),
	"legal_name" varchar(100) NOT NULL,
	"address_line1" varchar(100),
	"address_line2" varchar(100),
	"city" varchar(60),
	"pincode" char(6),
	"state_code" char(2) NOT NULL,
	"is_sez" boolean DEFAULT false NOT NULL,
	"updated_by" varchar(36),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tenant_tax_details_gstin_check" CHECK ("tenant_tax_details"."gstin" is null or "tenant_tax_details"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "tenant_tax_details_sez_check" CHECK (not "tenant_tax_details"."is_sez" or "tenant_tax_details"."gstin" is not null),
	CONSTRAINT "tenant_tax_details_state_check" CHECK ("tenant_tax_details"."gstin" is null or "tenant_tax_details"."state_code" = left("tenant_tax_details"."gstin", 2))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_type_check";--> statement-breakpoint
ALTER TABLE "billing_alerts" DROP CONSTRAINT "billing_alerts_kind_check";--> statement-breakpoint
ALTER TABLE "tenant_billing_subscriptions" ADD COLUMN "role" varchar(16) DEFAULT 'held' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_original_document_id_tax_documents_id_fk" FOREIGN KEY ("original_document_id") REFERENCES "public"."tax_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_held_charges" ADD CONSTRAINT "tax_held_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_held_charges" ADD CONSTRAINT "tax_held_charges_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_tax_details" ADD CONSTRAINT "tenant_tax_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_tax_details" ADD CONSTRAINT "tenant_tax_details_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_documents_invoice_payment_unique" ON "tax_documents" USING btree ("provider","provider_mode","payment_id") WHERE "tax_documents"."type" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_documents_refund_unique" ON "tax_documents" USING btree ("provider","provider_mode","refund_id") WHERE "tax_documents"."refund_id" is not null;--> statement-breakpoint
CREATE INDEX "tax_documents_tenant_issued_idx" ON "tax_documents" USING btree ("tenant_id","issued_at","id");--> statement-breakpoint
CREATE INDEX "tax_documents_issued_idx" ON "tax_documents" USING btree ("issued_at","id");--> statement-breakpoint
CREATE INDEX "tax_documents_original_idx" ON "tax_documents" USING btree ("original_document_id");--> statement-breakpoint
CREATE INDEX "tax_held_charges_tenant_held_idx" ON "tax_held_charges" USING btree ("tenant_id","held_at","id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_type_check" CHECK ("audit_logs"."target_type" is null or "audit_logs"."target_type" in ('tenant', 'membership', 'invitation', 'settings', 'user', 'email_message', 'email_suppression', 'platform', 'plan', 'billing', 'tax_document'));--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_kind_check" CHECK ("billing_alerts"."kind" in ('duplicate_refunded', 'webhook_failing', 'reconcile_repair', 'dispute', 'subscription_completed', 'tax_held_sez', 'tax_issue_failed', 'tax_invoice_late', 'tax_credit_note_late'));--> statement-breakpoint
ALTER TABLE "tenant_billing_subscriptions" ADD CONSTRAINT "tenant_billing_subscriptions_role_check" CHECK ("tenant_billing_subscriptions"."role" in ('held', 'duplicate', 'late_switch'));