DROP INDEX "email_messages_created_at_idx";--> statement-breakpoint
DROP INDEX "user_memberships_tenant_id_idx";--> statement-breakpoint
DROP INDEX "tenants_name_trgm_idx";--> statement-breakpoint
DROP INDEX "tenants_slug_trgm_idx";--> statement-breakpoint
CREATE INDEX "email_messages_created_sort_idx" ON "email_messages" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "email_messages_recipient_trgm_idx" ON "email_messages" USING gin (lower("recipient") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "email_suppressions_created_sort_idx" ON "email_suppressions" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "email_suppressions_address_sort_idx" ON "email_suppressions" USING btree ("address","id");--> statement-breakpoint
CREATE INDEX "email_suppressions_address_trgm_idx" ON "email_suppressions" USING gin ("address" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_created_sort_idx" ON "tenant_invitations" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_email_sort_idx" ON "tenant_invitations" USING btree ("tenant_id",lower("email"),"id");--> statement-breakpoint
CREATE INDEX "tenants_name_sort_idx" ON "tenants" USING btree (lower("name"),"id");--> statement-breakpoint
CREATE INDEX "tenants_created_sort_idx" ON "tenants" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "user_memberships_tenant_role_sort_idx" ON "user_memberships" USING btree ("tenant_id",(case "role" when 'owner' then 0 when 'admin' then 1 when 'manager' then 2 when 'editor' then 3 when 'viewer' then 4 else 5 end),"id");--> statement-breakpoint
CREATE INDEX "user_memberships_tenant_joined_sort_idx" ON "user_memberships" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "user_memberships_user_joined_sort_idx" ON "user_memberships" USING btree ("user_id","created_at","tenant_id");--> statement-breakpoint
CREATE INDEX "users_email_sort_idx" ON "users" USING btree (lower("email"),"id");--> statement-breakpoint
CREATE INDEX "users_created_sort_idx" ON "users" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "users_last_logged_in_sort_idx" ON "users" USING btree (coalesce("last_logged_in_at", '-infinity'::timestamptz),"id");--> statement-breakpoint
CREATE INDEX "users_email_trgm_idx" ON "users" USING gin (lower("email") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_first_name_trgm_idx" ON "users" USING gin (lower("first_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_last_name_trgm_idx" ON "users" USING gin (lower("last_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tenants_name_trgm_idx" ON "tenants" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tenants_slug_trgm_idx" ON "tenants" USING gin ("slug" gin_trgm_ops);