# Changelog

## [6.0.0](https://github.com/mahaverick/express-boilerplate/compare/v5.0.0...v6.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* passwords are removed; people sign in by an emailed single-use link or by Google, and a first click on a web link creates a verified account. Removed routes (they answer the unknown-route 404): POST /auth/register, /auth/login, /auth/verify-email, /auth/resend-verification, /auth/forgot-password, /auth/reset-password, /auth/change-password, /auth/reauthenticate, /platform/users/:id/password-setup and /platform/users/:id/resend-verification. New routes: POST /auth/link/request ({ email, app, redirect? }, one 202 for every address), POST /auth/link/verify ({ token, email? }; send the link's email, a mismatch answers 400 LINK_INVALID and spends nothing), POST /invitations/verify (a customer invitation to an address with no account signs the invitee in and joins them in one click; an address that has an account, and every staff invitation, answers 202 { confirmationSent: true, email } with no cookie and mails a 15-minute single-use confirm link), POST /invitations/confirm ({ token, email? }; the confirm link's click signs in as a recent sign-in and joins, and every refusal answers 404 invitation_invalid with its own next-step message and spends nothing; links, their cooldown and their issue lock are per address and invitation, so two invitations to one address each get a working link), POST /auth/step-up/link/request, POST /auth/step-up/link/verify, POST /auth/step-up/google/start, GET /auth/step-up/google, and POST /platform/users/:id/sign-in-link. Changed responses: GET /auth/providers and the platform user responses drop hasPassword; POST /invitations/accept adds alreadyMember; invitation lists add lastSentAt and resendAvailableAt; GET /auth/google takes an optional redirect; PUT /notifications/preferences answers 400 for verify_email, password_reset_requested and password_changed, which are no longer notification types; a one-click POST /invitations/verify session does not count as a recent sign-in, so a step-up route answers 401 REAUTH_REQUIRED until the user confirms it's them; in read_only a web Google sign-in that reaches no account redirects with error=READ_ONLY_MODE and creates nothing. Step-up is by emailed link or a fresh Google login (max_age=0, auth_time checked); the 401 REAUTH_REQUIRED contract is unchanged. Migration 0028 adds the sign_in_link and step_up_link purposes to user_tokens, makes user_tokens.user_id nullable (sign_in_link rows carry no user), and adds the email, app and redirect columns, user_tokens_live_email_idx, user_tokens_app_check and user_tokens_shape_check. Migration 0029 deletes every email_verification and password_reset token and the verify_email, password_reset_requested and password_changed notifications and preferences, narrows the purpose and shape CHECKs to refresh, sign_in_link and step_up_link, and drops users.password_hash. Migration 0030 adds the invitation_link purpose and the user_tokens.invitation_id column (a foreign key to tenant_invitations, ON DELETE CASCADE, with the partial index user_tokens_invitation_id_idx), and re-adds the purpose and shape CHECKs with it; existing rows have invitation_id NULL and pass. 0028, 0029 and 0030 take ACCESS EXCLUSIVE on user_tokens (0029 also on users; 0030 also SHARE ROW EXCLUSIVE on tenant_invitations, blocking invitation writes but not reads until the migration commits), so run the retention purge first and apply them in a quiet window. Removed variables: EMAIL_VERIFICATION_TTL, PASSWORD_RESET_TTL, PASSWORD_RESET_MAIL_COOLDOWN, REGISTRATION_ATTEMPT_NOTICE_COOLDOWN, ACCOUNT_SETUP_TTL and PLATFORM_EMAIL_DOMAINS (domain auto-join is gone; staff join by invitation or pnpm platform:grant, which creates a missing account verified and claims a never-verified one). New variables: SIGN_IN_LINK_TTL (15m), SIGN_IN_LINK_MAIL_COOLDOWN (1m), SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT (10), STEP_UP_LINK_TTL (15m) and STEP_UP_LINK_COOLDOWN (1m); INVITATION_TTL defaults to 3d. Workers run a fifth BullMQ queue, auth-email, for the sign_in_link, step_up_link, welcome, tenant_invitation and invitation_confirm mail, and full maintenance never pauses it. A forwarded invitation can no longer sign anyone in to an existing account or grant staff: only the invitee's mailbox receives the confirm link; the invitation_confirm template is new, and SIGN_IN_LINK_TTL and SIGN_IN_LINK_MAIL_COOLDOWN also govern the confirm link (its cooldown is counted separately, and it shares the sign-in daily budget). Each process now runs up to 2 x WORKER_CONCURRENCY SMTP sends at once (the email and auth-email workers each use it); lower WORKER_CONCURRENCY if you sized it against your mail provider's rate limit. Retired audit actions (auth.reauthenticated, user.password_setup_sent, user.verification_resent, platform.member.auto_joined) stay listable; the new ones are user.sign_in_link_sent, auth.step_up_confirmed and auth.step_up_refused. The password_changed and password_reset_completed analytics events are gone, and the server sign-in method is link or google (password is gone). Retired email templates (email_verification, password_reset, registration_attempt, password_changed, account_setup) stay listable, and a resend of one answers 409 template_unavailable. Every link a user receives carries utm_source, utm_medium, utm_campaign and utm_content (fixed constants, never PII); frontends keep utm_* values that match ^[a-z0-9_-]{1,64}$. Operator steps: delete the removed variables from every environment; deploy react and apex releases that use the new routes together with this API; apply 0028, 0029 and 0030 in a quiet window after a retention purge; restart every worker deployment so it runs the auth-email Worker; keep MAIL_FROM_TRANSACTIONAL's domain free of click tracking; no new Google Console redirect URI is needed (Google step-up shares /auth/google/callback); before release, confirm one Google step-up live, since a missing auth_time fails every Google step-up closed and staff then confirm by link.

### Features

* passwordless sign-in by email link and Google ([ef59e8c](https://github.com/mahaverick/express-boilerplate/commit/ef59e8ca5395f50506d03eedb0405e9df3564b9b))

## [5.0.0](https://github.com/mahaverick/express-boilerplate/compare/v4.3.0...v5.0.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* every list endpoint answers data as { items, page: { nextCursor, prevCursor, hasNext, hasPrev, limit }, total? }; the keys tenants, users, messages, suppressions, entries and notifications, and the bare arrays of GET /tenants, /tenants/:slug/members and /tenants/:slug/invitations, are gone, so /members, /invitations and /tenants are now paged (notifications already were; only their shape changes). Query params: q is search, tenantId is tenant, userId is user, actorUserId is actor, targetId is target; enum filters take comma lists, and the tenant and suppression state filters have no all value (send every state). Every list's limit is 1-100 with a default of 20; the audit-log default limit is 20 (it was 50). Cursors are signed and bound to their search, filters, sort, their own list and any tenant or user: set CURSOR_SECRET (32+ characters, the same on every replica) on every APP_ENV but local, or boot refuses; a cursor from another view or another list answers 400 CURSOR_INVALID. Every cursor issued before this release also answers 400 CURSOR_INVALID, so clients restart from the first page. GET /platform/flags returns the registry list only; its unregistered flags are GET /platform/flags/unregistered and its traits and snapshot GET /platform/flags/meta, so FlagsListResponse is now FlagsMetaResponse plus the two lists. GET /platform/users/:id/timeline, GET /platform/tenants/:id/timeline, GET /platform/users/:id/errors and GET /platform/tenants/:id/errors are removed; the audit actions user.timeline_viewed, tenant.timeline_viewed, user.errors_viewed and tenant.errors_viewed are no longer written (stored rows stay listable and filterable). TIMELINE_QUERY_BUDGET_PER_HOUR is removed. TIMELINE_REQUESTS_PER_MINUTE is renamed FLAG_EVALUATE_REQUESTS_PER_MINUTE and the old name is silently ignored, so the default of 20 applies until you rename it. The rate limiter platform-timeline is now flag-evaluate, so its counters reset on deploy. The error code TIMELINE_UNAVAILABLE is now POSTHOG_UNAVAILABLE. The PostHog personal API key no longer needs the query:read scope. Migrations 0026 (list sort and search indexes) and 0027 (a users full-name trigram index) take table locks: on a live database build their indexes by hand with CREATE INDEX CONCURRENTLY first, as DATABASE.md describes.

### Features

* one list API for every table ([a40e1d2](https://github.com/mahaverick/express-boilerplate/commit/a40e1d26a8e447230c08d8d17a4ac128d9d529bc))

## [4.3.0](https://github.com/mahaverick/express-boilerplate/compare/v4.2.0...v4.3.0) (2026-10-14)


### Features

* **rate-limit:** add RATE_LIMIT_SCALE for local end-to-end runs ([#121](https://github.com/mahaverick/express-boilerplate/issues/121)) ([7833af9](https://github.com/mahaverick/express-boilerplate/commit/7833af9c28439c9cb4d3a4fd368cb967aa3f11f4))

## [4.2.0](https://github.com/mahaverick/express-boilerplate/compare/v4.1.0...v4.2.0) (2026-10-13)


### Features

* **dev:** run the API, react and apex together with docker compose profiles ([#119](https://github.com/mahaverick/express-boilerplate/issues/119)) ([b7501dc](https://github.com/mahaverick/express-boilerplate/commit/b7501dc238869a5b45d38af26abded0e95d405e6))

## [4.1.0](https://github.com/mahaverick/express-boilerplate/compare/v4.0.0...v4.1.0) (2026-10-13)


### Features

* **notifications:** let users switch in-app notifications off, and close the express follow-ups ([#116](https://github.com/mahaverick/express-boilerplate/issues/116)) ([630fdaf](https://github.com/mahaverick/express-boilerplate/commit/630fdafc91b4f6681f52f1da0e3f0b52f40b722a))

## [4.0.0](https://github.com/mahaverick/express-boilerplate/compare/v3.0.2...v4.0.0) (2026-10-12)


### ⚠ BREAKING CHANGES

* **auth:** every password-setting endpoint (register, reset, change password, verify-email and invitation sign-up) now rejects a password shorter than 15 characters, counted in code points. Existing shorter passwords still sign in. A second click on a used verification link now answers 409 email_already_verified instead of 400.

### Features

* **auth:** require passwords of at least 15 characters ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))


### Bug Fixes

* **analytics:** refuse proxied requests that carry Expect with 417 ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **auth:** rehash an old-cost password hash on a successful login ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **env:** refuse an opaque origin in CORS_ALLOWED_ORIGINS ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **maintenance-mode:** count removal attempts honestly in dedupeSchedulerJobs ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **retention:** bound every batch delete at its limit ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **sessions:** make revokeAllSessions fail closed on its own ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))
* **verification:** answer 409 to a second click on a used link ([863a7f7](https://github.com/mahaverick/express-boilerplate/commit/863a7f71621045e80b1618bdb4de3e80388f567d))

## [3.0.2](https://github.com/mahaverick/express-boilerplate/compare/v3.0.1...v3.0.2) (2026-10-12)


### Bug Fixes

* **errors:** close the AWS-key, email-query and compass scrubber gaps ([#111](https://github.com/mahaverick/express-boilerplate/issues/111)) ([10de5c0](https://github.com/mahaverick/express-boilerplate/commit/10de5c021cbf1f5827ba31449fbe9a33c37bba1d))

## [3.0.1](https://github.com/mahaverick/express-boilerplate/compare/v3.0.0...v3.0.1) (2026-10-10)


### Bug Fixes

* **errors:** redact a key's value after a path, query or fragment placeholder ([#104](https://github.com/mahaverick/express-boilerplate/issues/104)) ([ac72837](https://github.com/mahaverick/express-boilerplate/commit/ac728374c0f8ec8ae0736e53f51a9a499d72ea6e))

## [3.0.0](https://github.com/mahaverick/express-boilerplate/compare/v2.1.0...v3.0.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* prune compat shims and dead code ([#102](https://github.com/mahaverick/express-boilerplate/issues/102))

### Features

* prune compat shims and dead code ([#102](https://github.com/mahaverick/express-boilerplate/issues/102)) ([fca2c1d](https://github.com/mahaverick/express-boilerplate/commit/fca2c1dd6a02f2fad09789ce14ee2a4637a01c01))

## [2.1.0](https://github.com/mahaverick/express-boilerplate/compare/v2.0.4...v2.1.0) (2026-10-10)


### Features

* **tenants:** member_not_found code and the platform members' active flag ([#100](https://github.com/mahaverick/express-boilerplate/issues/100)) ([6276f89](https://github.com/mahaverick/express-boilerplate/commit/6276f89b809e1530747c2207ce66c52e59078c8e))

## [2.0.4](https://github.com/mahaverick/express-boilerplate/compare/v2.0.3...v2.0.4) (2026-10-09)


### Bug Fixes

* **errors:** run scrubbed values through later keys and keep split secrets whole ([#98](https://github.com/mahaverick/express-boilerplate/issues/98)) ([83bd6b7](https://github.com/mahaverick/express-boilerplate/commit/83bd6b771f4f0d25180ca60ea547f09f734aeb83))

## [2.0.3](https://github.com/mahaverick/express-boilerplate/compare/v2.0.2...v2.0.3) (2026-10-09)


### Bug Fixes

* end grace sibling chains on revoke, bound stalled Redis calls, close two scrubber gaps ([#96](https://github.com/mahaverick/express-boilerplate/issues/96)) ([9d27819](https://github.com/mahaverick/express-boilerplate/commit/9d27819a9d2cc8d9ed62274cf4b0b73e561a08c5))

## [2.0.2](https://github.com/mahaverick/express-boilerplate/compare/v2.0.1...v2.0.2) (2026-10-08)


### Bug Fixes

* **errors:** close scrubber gaps, scrub Slack and bound status reads ([#93](https://github.com/mahaverick/express-boilerplate/issues/93)) ([715d9df](https://github.com/mahaverick/express-boilerplate/commit/715d9df8a28267f8fb728f0b564fd50275a8c074))

## [2.0.1](https://github.com/mahaverick/express-boilerplate/compare/v2.0.0...v2.0.1) (2026-10-08)


### Bug Fixes

* harden input, cursors and flag parsing; maintenance reason fixes, dependency advisories ([#91](https://github.com/mahaverick/express-boilerplate/issues/91)) ([941c263](https://github.com/mahaverick/express-boilerplate/commit/941c2635ab30052fdb9445663456e97f0e164d11))

## [2.0.0](https://github.com/mahaverick/express-boilerplate/compare/v1.9.0...v2.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* harden auth, sessions, limits and invitations; staff reason, leave tenant, sign out others ([#89](https://github.com/mahaverick/express-boilerplate/issues/89))

### Features

* harden auth, sessions, limits and invitations; staff reason, leave tenant, sign out others ([#89](https://github.com/mahaverick/express-boilerplate/issues/89)) ([830bef4](https://github.com/mahaverick/express-boilerplate/commit/830bef4fffd7a51ce172ab0d94058454f6beb827))

## [1.9.0](https://github.com/mahaverick/express-boilerplate/compare/v1.8.1...v1.9.0) (2026-10-06)


### Features

* maintenance mode (sp5e-1) — gate, queue pause, owner routes ([#86](https://github.com/mahaverick/express-boilerplate/issues/86)) ([a372f06](https://github.com/mahaverick/express-boilerplate/commit/a372f06d649e6c0c2414c1442078dd1e2667558f))

## [1.8.1](https://github.com/mahaverick/express-boilerplate/compare/v1.8.0...v1.8.1) (2026-10-06)


### Bug Fixes

* sp5d follow-ups — snapshot touch race, evaluate audit throttle key, server-event geoip ([#84](https://github.com/mahaverick/express-boilerplate/issues/84)) ([b406dc3](https://github.com/mahaverick/express-boilerplate/commit/b406dc3e9f1c17e8ae93b4f432a79d4d963745f7))

## [1.8.0](https://github.com/mahaverick/express-boilerplate/compare/v1.7.0...v1.8.0) (2026-10-05)


### Features

* server-evaluated feature flags and experiments (sp5d) ([#82](https://github.com/mahaverick/express-boilerplate/issues/82)) ([b6237e0](https://github.com/mahaverick/express-boilerplate/commit/b6237e0d1a7987182e59df43c8a40d3bdd6507cb))

## [1.7.0](https://github.com/mahaverick/express-boilerplate/compare/v1.6.0...v1.7.0) (2026-10-05)


### Features

* error tracking for server errors, staff errors views and system status ([#80](https://github.com/mahaverick/express-boilerplate/issues/80)) ([191baa9](https://github.com/mahaverick/express-boilerplate/commit/191baa90def0aebb23537c49642068cd0be4aa16))

## [1.6.0](https://github.com/mahaverick/express-boilerplate/compare/v1.5.0...v1.6.0) (2026-10-04)


### Features

* posthog timelines, purge deletion, group markers and signed events ([#78](https://github.com/mahaverick/express-boilerplate/issues/78)) ([4045fd4](https://github.com/mahaverick/express-boilerplate/commit/4045fd4fb5205b7e5f3446a0bb67b51f7645ce58))

## [1.5.0](https://github.com/mahaverick/express-boilerplate/compare/v1.4.0...v1.5.0) (2026-10-03)


### Features

* posthog event pipeline (outbox, drainer, /collect proxy) ([#75](https://github.com/mahaverick/express-boilerplate/issues/75)) ([4f7f806](https://github.com/mahaverick/express-boilerplate/commit/4f7f806fbce7323e94cdb393430e50d1672ef337))


### Bug Fixes

* **analytics:** keep good rows flowing when posthog refuses part of a batch ([#77](https://github.com/mahaverick/express-boilerplate/issues/77)) ([0327de9](https://github.com/mahaverick/express-boilerplate/commit/0327de9ebd3b2d4f83c7ff95c6b89df574d29b16))

## [1.4.0](https://github.com/mahaverick/express-boilerplate/compare/v1.3.0...v1.4.0) (2026-10-02)


### Features

* onboarding funnel (Apex SP4) ([#73](https://github.com/mahaverick/express-boilerplate/issues/73)) ([a1947ad](https://github.com/mahaverick/express-boilerplate/commit/a1947adcf5a5e69f9b376ba27681c6b8c4d6f46a))

## [1.3.0](https://github.com/mahaverick/express-boilerplate/compare/v1.2.1...v1.3.0) (2026-10-01)


### Features

* message tracking (Apex SP3) ([#69](https://github.com/mahaverick/express-boilerplate/issues/69)) ([e839e89](https://github.com/mahaverick/express-boilerplate/commit/e839e89627eb3b2aa013c9f0b672c57a9b8e25ba))

## [1.2.1](https://github.com/mahaverick/express-boilerplate/compare/v1.2.0...v1.2.1) (2026-10-01)


### Bug Fixes

* **deps:** bump transitive @grpc/grpc-js past GHSA-m9gg-hp2v-232j ([#70](https://github.com/mahaverick/express-boilerplate/issues/70)) ([69ba29a](https://github.com/mahaverick/express-boilerplate/commit/69ba29aeddc9700bc74123f60dc1f4b85e51b7f1))

## [1.2.0](https://github.com/mahaverick/express-boilerplate/compare/v1.1.0...v1.2.0) (2026-09-29)


### Features

* staff directory and management API (Apex SP2) ([#67](https://github.com/mahaverick/express-boilerplate/issues/67)) ([2a0761c](https://github.com/mahaverick/express-boilerplate/commit/2a0761c94e81c30512b9809bf800c71937c0336d))

## [1.1.0](https://github.com/mahaverick/express-boilerplate/compare/v1.0.0...v1.1.0) (2026-09-29)


### Features

* second frontend (APEX_URL) and platform stats ([#65](https://github.com/mahaverick/express-boilerplate/issues/65)) ([0e42c47](https://github.com/mahaverick/express-boilerplate/commit/0e42c47d07061087ba0291478ef23d757d9bbc81))

## 1.0.0 (2026-09-28)


### Features

* current-state comments and docs; restart at 1.0.0 ([#61](https://github.com/mahaverick/express-boilerplate/issues/61)) ([f53dcdc](https://github.com/mahaverick/express-boilerplate/commit/f53dcdcb38e5c286cb9a9940330eaa014a61bc22))
