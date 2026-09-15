# Structure

Where new code goes, and what it must be named. Every rule here is enforced
by `eslint-plugin-check-file` in [`eslint.config.mjs`](eslint.config.mjs) —
this document hand-mirrors that config rather than being generated from
it, so if they ever disagree, the config wins and this file is stale.
`pnpm lint` fails on a misnamed file in a governed directory.

## Governed directories (filename suffix enforced)

| Directory              | Required suffix   | Example                 | Status in this repo                                                                                                                                                  |
| ---------------------- | ----------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/controllers/`     | `*.controller.ts` | `user.controller.ts`    | `auth.controller.ts`, `profile.controller.ts`                                                                                                                        |
| `src/repositories/`    | `*.repository.ts` | `user.repository.ts`    | `base.repository.ts` (abstract; shared soft-delete/update-tracking policy), `user.repository.ts`, `user-token.repository.ts`                                         |
| `src/services/`        | `*.service.ts`    | `database.service.ts`   | `database.service.ts`, `redis.service.ts`                                                                                                                            |
| `src/validators/`      | `*.validators.ts` | `user.validators.ts`    | `auth.validators.ts` (also exports `parseBody`, the shared zod-to-`HttpError` bridge every validator uses), `profile.validators.ts`                                  |
| `src/routes/`          | `*.routes.ts`     | `user.routes.ts`        | `index.routes.ts` (builds and mounts the versioned `/api/v1` router — a router, not a re-export; see "No barrel files" below), `auth.routes.ts`, `profile.routes.ts` |
| `src/middlewares/`     | `*.middleware.ts` | `error.middleware.ts`   | `error.middleware.ts`, `request-id.middleware.ts`, `auth.middleware.ts` (`requireAuth`), `rate-limit.middleware.ts`                                                  |
| `src/database/models/` | `*.model.ts`      | `user.model.ts`         | `user.model.ts`, `user-token.model.ts` — see [DATABASE.md](DATABASE.md)                                                                                              |
| `src/utilities/`       | `*.utilities.ts`  | `response.utilities.ts` | `response.utilities.ts`, `duration.utilities.ts`, `password.utilities.ts` (`hashPassword`/`isPasswordValid`), `token.utilities.ts` (JWT + opaque refresh tokens)     |
| `src/constants/`       | `*.constants.ts`  | `global.constants.ts`   | `global.constants.ts`, `auth.constants.ts` (`BCRYPT_COST` and password/cookie constants — see [SECURITY.md](SECURITY.md))                                            |
| `src/configs/`         | `*.config.ts`     | `env.config.ts`         | `env.config.ts` — the only file allowed to read `process.env` — and `rate-limit-store.config.ts`                                                                     |

Mind the asymmetry: the norm is a **singular** suffix regardless of the
directory's own name — `controller`, `repository`, `service`,
`middleware`, `model`, `config` — but `src/validators/`, `src/utilities/`,
and `src/constants/` are exceptions that keep the directory's **plural**
form (`.validators`, `.utilities`, `.constants`). This is exactly what the
lint rule checks — get the suffix right and don't assume it follows the
directory's own plural/singular form.

Test files (`*.test.ts`), wherever they're colocated, are exempt from this
rule — a file ending in `.test` can never also satisfy a directory's
required suffix, so `check-file` is turned off for `**/*.test.ts` and
everything under `tests/`.

## Directories with no filename rule

| Directory                  | What goes here                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/`               | Ambient/global type augmentation (`.d.ts` files), e.g. `express.d.ts` extending `Express.Request`.                                                                                                                                                                                                                                                                                                    |
| `src/scripts/`             | Standalone tools run directly via `pnpm exec tsx`, not imported by the app — e.g. `generate-env-example.ts`. Must live inside `src/` (not a root-level `scripts/`) so `tsconfig.json`'s `include: ["src/**/*"]` and eslint's type-aware parser can see it.                                                                                                                                            |
| `src/lint-fixtures/`       | **Not application code.** A deliberately-circular pair of modules importing each other through the `@/` alias, so `tests/unit/lint-gates.test.ts` can prove `import-x/no-cycle` fires on aliased imports. It must sit under `src/` because `tsconfig.json` maps `@/*` to `./src/*` only; it is excluded from the build, from `pnpm lint`, and from coverage. Don't import it and don't fix the cycle. |
| `src/database/migrations/` | Generated by `drizzle-kit generate` — and **committed**: CI and the production image replay migrations, they never regenerate them. Do not hand-write or hand-edit files here, and do not git-ignore them — see [DATABASE.md](DATABASE.md).                                                                                                                                                           |

## Root files (no directory, no suffix rule)

`src/app.ts`, `src/server.ts`, `src/index.ts` sit directly under `src/` and
name the three stages of the boot sequence (see
[ARCHITECTURE.md](ARCHITECTURE.md)) rather than a role a suffix could
encode. There is deliberately only one of each.

## Folder naming

Every folder under `src/` must be `kebab-case`
(`check-file/folder-naming-convention`). There are no multi-word directory
names in this repo yet, so this hasn't been exercised beyond the
single-word directories above — keep it in mind the first time one is.

## No barrel files

There is no `index.ts` re-export file anywhere in `src/`, and none should
be added. Import the module directly:

Direct import — correct:

```ts
import { getEnv } from '@/configs/env.config'
```

Barrel import — avoid, and there is nothing to import it from anyway:

```ts
import { getEnv } from '@/configs'
```

A barrel would also fail `check-file/filename-naming-convention` in every
governed directory (an `index.ts` under `src/services/` cannot end in
`.service`), and it hides real edges from `import-x/no-cycle` — a cycle
routed through a barrel is invisible to that rule. See
[CLAUDE.md](CLAUDE.md) for the reasoning in one place.

## Adding a new governed directory

If a later plan introduces a new top-level concern under `src/` (e.g.
`src/jobs/` for a queue consumer), add its naming rule to
`check-file/filename-naming-convention` in `eslint.config.mjs` **and** add a
row to the "Governed directories" table above in the same change — this
file drifting from the lint rule is exactly the failure mode it exists to
prevent.
