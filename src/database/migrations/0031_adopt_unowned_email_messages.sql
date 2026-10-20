-- hand-added: give each live account the mail its address was sent before the account existed (user_id NULL), skipping mail older than an earlier, soft-deleted holder's deletion. New accounts adopt theirs at creation (EmailMessageRepository.adoptUnowned).
UPDATE "email_messages" AS "m" SET "user_id" = "u"."id"
FROM "users" AS "u"
WHERE "m"."user_id" IS NULL
  AND "u"."deleted_at" IS NULL
  AND lower("m"."recipient") = lower("u"."email")
  AND "m"."created_at" > coalesce((
    SELECT max("d"."deleted_at") FROM "users" AS "d"
    WHERE lower("d"."email") = lower("u"."email") AND "d"."deleted_at" IS NOT NULL
  ), '-infinity'::timestamptz);
