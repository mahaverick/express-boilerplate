CREATE INDEX "billing_events_tenant_received_sort_idx" ON "billing_events" USING btree ("tenant_id","received_at","id");--> statement-breakpoint
-- Hand-ordered: the build first, under SHARE (reads continue); the drop's ACCESS EXCLUSIVE then waits only for the commit.
DROP INDEX "billing_events_tenant_received_idx";
