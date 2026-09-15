# Implementation plan index

The approved spec is `../specs/2026-09-14-modernization-design.md`. It covers
several independent subsystems, so it is executed as a sequence of plans rather
than one. Each plan leaves the repo green — `pnpm lint`, `pnpm test` and
`pnpm build` all pass — and each produces something that works on its own.

## Backend (this repo)

| #   | Plan                               | Delivers                                                                                                                                         | Depends on |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| B1  | `2026-09-14-backend-foundation.md` | Express 5 + ESM + pnpm app that boots, validates its env, serves `/health` and `/health/ready`, with the full toolchain, CI and hygiene in place | —          |
| B2  | `backend-auth.md`                  | Registration, login, refresh rotation, email verify, forgot/reset, Google OAuth, MFA (TOTP + recovery codes)                                     | B1         |
| B3  | `backend-tenancy.md`               | Tenants, memberships, RBAC, invitations, `audit_log`, cursor pagination                                                                          | B2         |
| B4  | `backend-billing.md`               | Stripe catalog, subscriptions, webhooks, entitlements, onboarding state machine, consent + retention                                             | B3         |
| B5  | `backend-platform.md`              | BullMQ jobs, email transports, storage adapters, OpenAPI + `/docs`, seeders, `pnpm bootstrap`                                                    | B4         |

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
