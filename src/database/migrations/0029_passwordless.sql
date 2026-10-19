ALTER TABLE "user_tokens" DROP CONSTRAINT "user_tokens_purpose_check";--> statement-breakpoint
ALTER TABLE "user_tokens" DROP CONSTRAINT "user_tokens_shape_check";--> statement-breakpoint
-- hand-added: the email_verification and password_reset rows the narrowed purpose and shape CHECKs refuse.
DELETE FROM "user_tokens" WHERE "purpose" IN ('email_verification', 'password_reset');--> statement-breakpoint
-- hand-added: the in-app notifications of the removed password and verification types.
DELETE FROM "notifications" WHERE "type" IN ('verify_email', 'password_reset_requested', 'password_changed');--> statement-breakpoint
-- hand-added: the preferences stored for those removed notification types.
DELETE FROM "notification_preferences" WHERE "notification_type" IN ('verify_email', 'password_reset_requested', 'password_changed');--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_purpose_check" CHECK ("user_tokens"."purpose" in ('refresh', 'sign_in_link', 'step_up_link'));--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_shape_check" CHECK (("user_tokens"."purpose" = 'refresh' and "user_tokens"."user_id" is not null and "user_tokens"."email" is null and "user_tokens"."app" is null and "user_tokens"."redirect" is null) or ("user_tokens"."purpose" = 'sign_in_link' and "user_tokens"."user_id" is null and "user_tokens"."session_id" is null and "user_tokens"."email" is not null and "user_tokens"."app" is not null) or ("user_tokens"."purpose" = 'step_up_link' and "user_tokens"."user_id" is not null and "user_tokens"."session_id" is not null and "user_tokens"."email" is not null and "user_tokens"."app" is not null and "user_tokens"."redirect" is null));