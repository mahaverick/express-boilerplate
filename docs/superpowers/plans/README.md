# Implementation plan index

The approved spec is `../specs/2026-09-14-modernization-design.md`. It covers
several independent subsystems, so it is executed as a sequence of plans rather
than one. Each plan leaves the repo green — `pnpm lint`, `pnpm test` and
`pnpm build` all pass — and each produces something that works on its own.

## Backend (this repo)

| #   | Plan                                                                                                                                                                                                       | Delivers                                                                                                                                                                                                                         | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B1  | `2026-09-14-backend-foundation.md`                                                                                                                                                                         | Express 5 + ESM + pnpm app that boots, validates its env, serves `/health` and `/health/ready`, with the full toolchain, CI and hygiene in place                                                                                 | —          |
| B2  | `2026-09-15-users-and-password-auth.md`                                                                                                                                                                    | User model, migrations, bcrypt, register/login/logout, JWT access + refresh rotation with reuse detection, auth middleware, login rate limiting, profile                                                                         | B1         |
| B3  | `email-and-recovery.md` **(PARTIAL — tasks 0/1/4/2/3 done; 5 and 7 partly done — verification and its rate limiters, on `feat/verify-email`; 6 and 8 unbuilt, see the plan's "Execution status" section)** | Email-verification token **issuing and verification** (B2 reserved the `email_verified_at` column but built no token flow — see the correction below), plus nodemailer + Mailpit, templates, delivery, and forgot/reset password | B2         |
| B4  | `federated-identity-and-mfa.md`                                                                                                                                                                            | Google OAuth via Passport, MFA (TOTP + single-use recovery codes), step-up checks                                                                                                                                                | B2         |
| B5  | `tenancy.md`                                                                                                                                                                                               | Tenants, memberships, RBAC, invitations, `audit_log`, cursor pagination                                                                                                                                                          | B4         |
| B6  | `billing.md`                                                                                                                                                                                               | Stripe catalog, subscriptions, webhooks, entitlements, onboarding state machine, consent + retention                                                                                                                             | B5         |
| B7  | `platform.md`                                                                                                                                                                                              | BullMQ jobs, storage adapters, OpenAPI + `/docs`, seeders, `pnpm bootstrap`                                                                                                                                                      | B6         |

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

**Correction to B2's scope, found by its own Task 9.** B2's plan asserted in its
self-review that "email verification tokens are issued and verifiable here;
delivery belongs to B3". That was wrong: no task in B2 built a token flow, and
only the reserved `email_verified_at` column exists. The spec-coverage check that
made the claim did not verify it. B3 therefore owns the whole flow — issuing,
verifying and delivering — not delivery alone. The documentation shipped in B2
describes the real state rather than the planned one.

## B3 stopped after Task 3 (2026-09-15)

B3 shipped its token store, delivery log, mail transport and templates. It did
**not** ship email verification, forgot/reset password, their rate limiting, or
the documentation pass — tasks 5 through 8.

Anyone resuming must read the **"Execution status"** section at the end of
`2026-09-15-email-and-recovery.md` before starting Task 5. It records an
enumeration oracle that Task 5 _opens_ rather than closes — closing the register
response lets an attacker read the whole user base through `login`, because
register creates the account with the attacker's own password — and the exact fix,
verified against the current controller. It also records the four distinct
channels through which the "a send failure must not change the response"
guarantee has already been defeated, one of which is still open, and the data
retention gap B3 widened and nobody owns.

`users.email_verified_at` remained a column nothing wrote to, as of this
2026-09-15 stopping point. The "B3 seam" in ARCHITECTURE.md was still a seam.

**Resumed 2026-09-16, on `feat/verify-email` (Task 5 and part of Task 7).**
Email verification, `resend-verification`, the `login` guard that closes
finding 1 above, and rate limiting for those two routes are now built — see
`docs/superpowers/specs/2026-09-15-verify-email-and-login-timestamps-design.md`.
ARCHITECTURE.md's "B3 seam" section now describes what exists rather than
what is still missing. Forgot/reset password (Task 6), the
`/forgot-password`/`/reset-password` rate limiters (the rest of Task 7), and
the full documentation pass (Task 8) are still unbuilt.
