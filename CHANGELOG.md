# Changelog

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
