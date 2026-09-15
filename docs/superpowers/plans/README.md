# Implementation plan index

The approved spec is `../specs/2026-09-14-modernization-design.md`. It covers
several independent subsystems, so it is executed as a sequence of plans rather
than one. Each plan leaves the repo green — `pnpm lint`, `pnpm test` and
`pnpm build` all pass — and each produces something that works on its own.

## Backend (this repo)

| #   | Plan                                    | Delivers                                                                                                                                                 | Depends on |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B1  | `2026-09-14-backend-foundation.md`      | Express 5 + ESM + pnpm app that boots, validates its env, serves `/health` and `/health/ready`, with the full toolchain, CI and hygiene in place         | —          |
| B2  | `2026-09-15-users-and-password-auth.md` | User model, migrations, bcrypt, register/login/logout, JWT access + refresh rotation with reuse detection, auth middleware, login rate limiting, profile | B1         |
| B3  | `email-and-recovery.md`                 | nodemailer + Mailpit, templates, email-verification delivery, forgot/reset password                                                                      | B2         |
| B4  | `federated-identity-and-mfa.md`         | Google OAuth via Passport, MFA (TOTP + single-use recovery codes), step-up checks                                                                        | B2         |
| B5  | `tenancy.md`                            | Tenants, memberships, RBAC, invitations, `audit_log`, cursor pagination                                                                                  | B4         |
| B6  | `billing.md`                            | Stripe catalog, subscriptions, webhooks, entitlements, onboarding state machine, consent + retention                                                     | B5         |
| B7  | `platform.md`                           | BullMQ jobs, storage adapters, OpenAPI + `/docs`, seeders, `pnpm bootstrap`                                                                              | B6         |

**Why B2 was split.** The original index made B2 a single plan covering password
auth, email delivery, OAuth and MFA. That is three independent subsystems, and
the writing-plans scope check rejects it: each plan must produce working,
testable software on its own. Password authentication does — you can register,
log in, rotate a refresh token and call an authenticated route with nothing else
built. Email delivery and federated identity are separable and now have their
own plans. B1 ran to ten tasks and surfaced six gates that reported success
while enforcing nothing; a fifteen-task plan would have hidden more of them.

## Frontend (`../../../react-boilerplate`)

| #   | Plan                     | Delivers                                                                                              | Depends on |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ---------- |
| F1  | `frontend-foundation.md` | React 19 + Vite 8 + TanStack Router app that boots, validates its env, with toolchain, CI and hygiene | B1         |
| F2  | `frontend-http-auth.md`  | http layer (client, interceptors, refresh race, SSE), auth stores, `_auth` routes                     | B2, F1     |
| F3  | `frontend-ui-kit.md`     | 48 Base UI components with Testing Library tests and the token system                                 | F1         |
| F4  | `frontend-app.md`        | `_onboarding` and `_protected` routes: dashboard, team, settings, billing                             | B4, F2, F3 |

Write each plan immediately before executing it, not all up front — later plans
depend on interfaces earlier ones actually produce, and a plan written against
a guess is a plan that gets rewritten.
