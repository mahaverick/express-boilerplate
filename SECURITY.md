# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability.
Email the maintainer listed in [CODEOWNERS](.github/CODEOWNERS) with a
description of the issue and, if possible, steps to reproduce it. Expect an
initial response within a few business days.

## Supported versions

This is a boilerplate, not a hosted service: only the `main` branch is
supported. Downstream projects generated from it are responsible for their
own patch cadence — `dependabot.yml` is wired up so that starts on day one.

## What this boilerplate does NOT implement

**Read this section before deciding what your project does not need to
add.** This repository is platform plumbing: environment validation,
database/Redis clients, health checks, an error contract, the test harness
and the lint/CI gates. It ships **no application security controls at all**,
and a downstream project inherits none of the following:

| Control                | Status              | What that means for you                                                                         |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| Authentication         | **Not implemented** | There is no auth middleware, no token issuing or verification, no session. Every route is open. |
| Password hashing       | **Not implemented** | No `bcrypt`, no `argon2`, no user table. Nothing hashes anything.                               |
| Security headers / CSP | **Not implemented** | `helmet` is not a dependency. Only `x-powered-by` is disabled (`src/app.ts`).                   |
| CORS                   | **Not implemented** | No `cors` middleware; `WEB_URL` is validated but nothing reads it.                              |
| Rate limiting          | **Not implemented** | No limiter, no Redis-backed throttle.                                                           |
| Input validation       | Schema only for env | `zod` validates the environment. No request-body validator exists yet.                          |

Verify any row above with `grep` before trusting this table — that is
exactly how these three sections came to be rewritten. An earlier revision
of this file described bcrypt at cost 12, an explicit helmet CSP, and
Bearer-token authentication in the present indicative, as shipped behaviour.
None of it existed. The danger of that is specific and asymmetric: this is
the file a downstream project reads to decide what it does _not_ have to
build, so an overstatement here silently removes a control from a real
system. [ARCHITECTURE.md](ARCHITECTURE.md)'s "What is deliberately not here
yet" is the companion list and has always been accurate.

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `SESSION_SECRET` are required
by the environment schema but **read by nothing** — they are forward
declarations for the auth plan below, not evidence that auth exists.

## Intended choices, when these are built

Recorded here so the decision is made deliberately rather than by whichever
snippet gets pasted in first. None of this is implemented today.

### Authentication: stateless Bearer tokens

The intended shape is a short-lived access token in an `Authorization:
Bearer` header plus a refresh token, which is what `JWT_ACCESS_SECRET` /
`JWT_REFRESH_SECRET` are reserved for. `SESSION_SECRET` is reserved for the
case where a browser session is layered on top. Nothing enforces this yet;
a project that wants a different model (opaque tokens in Redis, a
third-party IdP) should change it before writing routes against it, not
after.

### Password hashing: bcrypt at cost 12

Implemented: `src/utilities/password.utilities.ts` exports `hashPassword`/
`isPasswordValid`, backed by `BCRYPT_COST = 12` in
`src/constants/auth.constants.ts`.
`tests/unit/utilities/password.utilities.test.ts` asserts the cost embedded
in every hash it produces against that constant, and separately reads this
file off disk and asserts the number in the heading above still matches
`BCRYPT_COST` — so this sentence cannot drift from the code the way an
earlier revision of this file did (see the warning above this table).

[OWASP's current
guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
still prefers argon2id over bcrypt; a greenfield project with no existing
password column has no migration to plan and should take it instead. This
boilerplate already committed a `users` table with a bcrypt-shaped
`password_hash varchar(60)` column before this decision was revisited, so
bcrypt at cost 12 is the accepted, well-understood choice made here —
switching hashing algorithms afterwards requires either a dual-verify
migration path or a forced reset for everyone, which is the reason to decide
this deliberately rather than default into it.

Every password is also capped at 72 bytes (`MAX_PASSWORD_BYTES`, same file):
bcrypt itself silently ignores anything past that point, so without a cap
two different passwords sharing that 72-byte prefix would hash identically
and either would then verify successfully against the other's hash.
Hashing or verifying refuses an over-length password outright instead of
silently truncating it.

This is the hashing primitive only: no registration or login route calls it
yet, and nothing writes a `password_hash` outside this section's own test.

### Security headers: an explicit Content-Security-Policy

When `helmet` is added, configure the CSP explicitly rather than taking the
library defaults. Helmet's default CSP is a reasonable starting point but is
not tailored to this API's actual origins (its own `APP_URL`, the configured
`WEB_URL`, and nothing else), and an explicit policy is auditable in a diff
where "whatever helmet defaults to in this version" is not.

### No CSRF middleware — reasoning about the intended design

This is reasoning about the design above, not a claim about shipped code:
**there is no authentication here to protect yet.** Given the stateless
Bearer-token model, CSRF middleware would defend against an attack the
transport doesn't allow. CSRF relies on a browser automatically attaching
ambient credentials (a session cookie) to a cross-site request — an
`Authorization: Bearer <token>` header is never sent automatically by a
browser, and `SameSite=Lax`/`Strict` on any cookie that is used blocks it
being attached cross-site in the first place. If a project layers a browser
session on top of this boilerplate (the `SESSION_SECRET` path), this
conclusion no longer holds and CSRF protection must be revisited
explicitly.

## Design decisions that ARE implemented

Each is written down because "we have no protection here" and "this attack
does not apply to this design" look identical in a code review, and only one
of them is a finding.

### Secret scanning at two layers

[`gitleaks`](https://github.com/gitleaks/gitleaks) runs as an optional local
pre-commit hook (`.pre-commit-config.yaml`, `.gitleaks.toml`) and as a
blocking check on every pull request
(`.github/workflows/gitleaks.yml`). The local hook alone is not a gate — it
is one `git commit --no-verify` away from being skipped — so the CI workflow
is the actual enforcement layer; the pre-commit hook exists to catch a leak
before it is even pushed.

### Domain-leak gate

This boilerplate is derived from a production codebase by stripping
project-specific terms. `.github/workflows/ci.yml`'s "Reject domain leakage"
step greps the tree for the terms that must never reappear, so a missed scrub
fails CI instead of shipping silently.

### No `npx <tool>@latest` in committed agent config

An earlier draft of this repository's documentation shipped a `.mcp.json`
declaring an MCP server as `npx shadcn@latest mcp`, plus a
`.claude/settings.json` that auto-enabled a plugin. Both were rejected
before merging, for reasons worth keeping visible so the same shape doesn't
reappear:

- **Unpinned execution outside the lockfile.** `npx <pkg>@latest` resolves
  and runs whatever is newest on the npm registry at the moment the tool
  launches — not a version anyone reviewed, not a version pnpm's lockfile
  or `pnpm audit` has any visibility into. A compromise of that package or
  its publishing account is code execution on every machine that opens the
  repo, with no review window between publish and execution.
- **Auto-enabling removes the one consent step that would catch it.** A
  `.claude/settings.json` that enables a plugin or server by default means
  a contributor never sees, let alone approves, what just started running.
- **A boilerplate multiplies the exposure.** This isn't one repository's
  risk; it's every project generated from this template inheriting the
  same unpinned, auto-enabled server on day one.
- It was also, independently, a frontend tool (a React component
  generator) copied into a backend API's agent config without checking
  whether anything here would ever use it. Nothing does.

**The rule:** a project that wants an MCP server adds one deliberately, at
a version pinned in the committed config (not `@latest`), and does not
auto-enable it for every contributor by default.
