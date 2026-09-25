# Changelog

## [3.0.0](https://github.com/mahaverick/express-boilerplate/compare/v2.0.0...v3.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* environment alignment (stream 3) ([#50](https://github.com/mahaverick/express-boilerplate/issues/50))

### Features

* environment alignment (stream 3) ([#50](https://github.com/mahaverick/express-boilerplate/issues/50)) ([503d731](https://github.com/mahaverick/express-boilerplate/commit/503d731e75d2261fc6b34943423ce82db75dca59))

## [2.0.0](https://github.com/mahaverick/express-boilerplate/compare/v1.1.1...v2.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* POST /api/v1/tenants/:slug/members is removed. Invite members with POST /api/v1/tenants/:slug/invitations; the invitee accepts with POST /api/v1/invitations/accept.

### Features

* tenant invitations and notification pub/sub (stream 1b, express) ([#46](https://github.com/mahaverick/express-boilerplate/issues/46)) ([a5e5628](https://github.com/mahaverick/express-boilerplate/commit/a5e56284368fff45d527ee6800ac3d04eb0bd6d9))


### Bug Fixes

* stream 1a security and correctness fixes (express) ([#45](https://github.com/mahaverick/express-boilerplate/issues/45)) ([cdb2ebb](https://github.com/mahaverick/express-boilerplate/commit/cdb2ebb7ff5fa44dbece9f69d968e42dc0446a29))

## [1.1.1](https://github.com/mahaverick/express-boilerplate/compare/v1.1.0...v1.1.1) (2026-09-24)


### Bug Fixes

* SP1 review follow-ups (logging edge cases, SSE header test, Corepack tracking) ([#39](https://github.com/mahaverick/express-boilerplate/issues/39)) ([5d77a14](https://github.com/mahaverick/express-boilerplate/commit/5d77a14a6b0d7a22f244b48248f1c561a231b0d5))

## [1.1.0](https://github.com/mahaverick/express-boilerplate/compare/v1.0.0...v1.1.0) (2026-09-24)


### Features

* pino logs to Loki, helmet headers, and a CI-gated deploy workflow ([#37](https://github.com/mahaverick/express-boilerplate/issues/37)) ([745838c](https://github.com/mahaverick/express-boilerplate/commit/745838c7027042efb1ca7754c67b37eef889f3c0))
