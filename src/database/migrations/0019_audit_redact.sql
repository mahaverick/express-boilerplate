ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_user_check";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_target_occurred_idx" ON "audit_logs" USING btree ("target_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_logs_recipient_lower_idx" ON "email_logs" USING btree (lower("recipient"));--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_check" CHECK ("audit_logs"."actor_kind" <> 'system' or "audit_logs"."actor_user_id" is null);--> statement-breakpoint
-- Hand-added: audit_logs stays append-only, with two narrow exits. DELETE
-- passes only inside the retention purge's settings (0017). An UPDATE passes
-- only inside a transaction that set app.audit_redact to 'on', and only when
-- it sets actor_user_id, ip and user_agent to NULL and changes no other
-- column: a staff purge erasing a person from the entries they acted in.
CREATE OR REPLACE FUNCTION "audit_logs_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF coalesce(current_setting('app.audit_redact', true), '') = 'on'
      AND NEW."actor_user_id" IS NULL
      AND NEW."ip" IS NULL
      AND NEW."user_agent" IS NULL
      AND (to_jsonb(NEW) - ARRAY['actor_user_id', 'ip', 'user_agent'])
        = (to_jsonb(OLD) - ARRAY['actor_user_id', 'ip', 'user_agent'])
    THEN
      RETURN NEW;
    END IF;
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
