DROP INDEX "billing_events_tenant_received_idx";--> statement-breakpoint
CREATE INDEX "billing_events_tenant_received_sort_idx" ON "billing_events" USING btree ("tenant_id","received_at","id");