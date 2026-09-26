CREATE INDEX "email_logs_created_at_idx" ON "email_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_read_at_idx" ON "notifications" USING btree ("read_at") WHERE "notifications"."read_at" is not null;--> statement-breakpoint
CREATE INDEX "notifications_unread_created_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "user_tokens_replaced_by_id_idx" ON "user_tokens" USING btree ("replaced_by_id");--> statement-breakpoint
CREATE INDEX "user_tokens_expires_at_idx" ON "user_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_tokens_revoked_unconsumed_idx" ON "user_tokens" USING btree ("revoked_at") WHERE "user_tokens"."revoked_at" is not null and "user_tokens"."consumed_at" is null;--> statement-breakpoint
-- Hand-added: audit_logs stays append-only except for the retention purge.
-- UPDATE always raises. DELETE raises unless the deleting transaction set
-- app.audit_purge to 'on' and app.audit_purge_before past the row's
-- occurred_at, both with set_config(..., true). current_setting(..., true)
-- is NULL when unset, and IF on NULL does not raise, so every read coalesces.
CREATE OR REPLACE FUNCTION "audit_logs_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  IF NOT coalesce(
    coalesce(current_setting('app.audit_purge', true), '') = 'on'
      AND OLD."occurred_at" < coalesce(nullif(current_setting('app.audit_purge_before', true), ''), '-infinity')::timestamptz,
    false
  ) THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  RETURN OLD;
END;
$$;
