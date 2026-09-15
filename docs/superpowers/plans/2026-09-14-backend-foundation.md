# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into an Express 5 / ESM / pnpm service that boots on a validated environment, serves liveness and readiness probes, and enforces its own lint, type, test, coverage and documentation standards in CI — with no domain code yet.

**Architecture:** The repo is rebuilt from the toolchain up rather than migrated. `src/app.ts` builds and returns an Express app with no side effects (so supertest can import it without a listening socket); `src/server.ts` owns the socket, the workers and graceful shutdown; `src/index.ts` is a ten-line entrypoint that fails fast on a bad environment. Configuration is parsed once by a Zod schema and consumed as a typed frozen object — never `process.env` at the point of use.

**Tech Stack:** Node 24, pnpm 12.4.1, TypeScript 7, Express 5, Zod 4, Vitest 5, supertest, ESLint 10 flat config, Drizzle 0.45 + Postgres 18, Redis 7.2, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-14-modernization-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- Node `>=24` (`.nvmrc`: `24`). Verified 2026-09-14: 24 "Krypton" is Active LTS; 22 is Maintenance.
- pnpm `12.4.1` via `packageManager`. ESM only — `"type": "module"`.
- TypeScript **`~6.0.3`** — Task 0's spike returned NO-GO on 7.0.2. `typescript-eslint@8.70.0` (also `latest`) declares peer `typescript: >=4.8.4 <6.1.0`, excluding all of 7.x. TypeScript 7 itself passed every check; the lint toolchain is the sole blocker. See `docs/superpowers/notes/2026-09-14-typescript-7-spike.md` and the `MIGRATIONS.md` row Task 9 writes.
- Express `5.2.1`, Zod `4.6.5`, Vitest `5.0.0`, ESLint `10.10.0`, Drizzle ORM `0.45.2`, drizzle-kit `0.31.10`.
- Module settings are core's, which are proven in production: `module: ES2022`, `moduleResolution: Bundler`, `paths: {"@/*": ["./src/*"]}`, **no `baseUrl`**, **no `verbatimModuleSyntax`**. Internal imports are extensionless (`@/configs/env.config`) — core runs 2,997 of them and zero `.js`; `tsc-alias --resolve-full-paths` adds the extension at emit. Do not switch to NodeNext: it forces `.js` on every import and contradicts every code sample in this plan.
- Coverage thresholds: **80%** lines, functions, branches, statements. CI runs `vitest run --coverage`, so they gate.
- `eslint-plugin-jsdoc` `64.4.0` with `publicOnly: true`; descriptions required; **types NOT required** — TypeScript carries them.
- `eslint-plugin-check-file` pins filenames: `*.controller.ts`, `*.repository.ts`, `*.service.ts`, `*.validators.ts`, `*.middleware.ts`, `*.model.ts`, `*.utilities.ts`, `*.constants.ts`, `*.config.ts`; kebab-case folders.
- `@/*` path alias resolving to `src/*`; `tsc-alias --resolve-full-paths` on build.
- Every module carries a file-header comment saying what it is for and, where non-obvious, **why it exists**.
- No secret may be read from `process.env` outside `src/configs/env.config.ts`.
- Conventional commits, enforced by commitlint 21.

---

## Task 0: TypeScript 7 compatibility spike

This is a **gate**, not a build step. Every later task writes TypeScript; if the toolchain does not hold under TS 7's native compiler, we need to know now and pin to 6 with the reason recorded. Output is an answer plus one committed note — not code we keep.

**Files:**

- Create: `docs/superpowers/notes/2026-09-14-typescript-7-spike.md`

- [ ] **Step 1: Scratch a probe project outside the repo**

```bash
mkdir -p /tmp/ts7-spike && cd /tmp/ts7-spike
pnpm init
pnpm add -D typescript@7.0.2 typescript-eslint@8.70.0 eslint@10.10.0 tsc-alias@1.9.0 tsx@4.23.13
```

- [ ] **Step 2: Give it the exact tsconfig the boilerplate will use**

```bash
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "noEmitOnError": true
  },
  "include": ["src/**/*"]
}
JSON
mkdir -p src && printf 'export const greet = (name: string): string => `hi ${name}`\n' > src/a.ts
printf "import { greet } from '@/a'\nconsole.log(greet('x'))\n" > src/index.ts
```

- [ ] **Step 3: Run each tool and record pass/fail**

```bash
npx tsc --noEmit;        echo "tsc --noEmit  -> $?"
npx tsc;                 echo "tsc emit      -> $?"
npx tsc-alias --resolve-full-paths; echo "tsc-alias -> $?"
node dist/index.js;      echo "runtime       -> $?"
npx tsx src/index.ts;    echo "tsx           -> $?"
npx eslint --version;    echo "eslint        -> $?"
```

Expected: every command exits 0 and `node dist/index.js` prints `hi x`. The one to watch is `tsc-alias`, which rewrites emitted import paths and depends on the emit shape.

- [ ] **Step 4: Check typescript-eslint supports TS 7**

```bash
npm view typescript-eslint@8.70.0 peerDependencies
```

Expected: the `typescript` peer range includes `7.x`. If it does not, `pnpm lint` will warn or fail on every run.

- [ ] **Step 5: Write the note and take the decision**

Record in `docs/superpowers/notes/2026-09-14-typescript-7-spike.md`: each command, its exit code, the peer range, and one of two verdicts.

- **GO** — `typescript: 7.0.2` in Global Constraints stands.
- **NO-GO** — pin `typescript: ~6.0.3` in every later task, and add a row to `MIGRATIONS.md` naming the blocking tool and the version that would unblock it. This is a recorded decision, not a silent downgrade.

- [ ] **Step 6: Commit the note and delete the probe**

```bash
rm -rf /tmp/ts7-spike
git add docs/superpowers/notes/2026-09-14-typescript-7-spike.md
git commit -m "docs: record TypeScript 7 toolchain spike result"
```

---

## Task 1: Strip the repo to a pnpm + ESM + TypeScript shell

**Files:**

- Modify: `package.json` (full rewrite)
- Create: `tsconfig.json`, `.nvmrc`, `.npmrc`, `.gitignore`
- Delete: `yarn.lock`, `.eslintrc.cjs`, `jest.config.cjs`, `nodemon.json`, `src/**` (every file — it is re-derived from `core` in tasks 4 onward and in plans B2–B5)

**Interfaces:**

- Consumes: Task 0's GO/NO-GO verdict for the `typescript` version.
- Produces: a repo where `pnpm install` succeeds and `pnpm exec tsc --noEmit` passes on an empty `src/`.

- [ ] **Step 1: Record what is being deleted, so the port has a checklist**

```bash
git ls-files src > docs/superpowers/notes/2026-09-14-pre-port-file-inventory.txt
wc -l docs/superpowers/notes/2026-09-14-pre-port-file-inventory.txt
```

Expected: 50 lines. Nothing in that list is ported as-is — `institute.model.ts` and `provider.model.ts` are education-domain leftovers and `organization.model.ts` is superseded by `tenant.model.ts` — but the file is the record of what the old repo contained.

- [ ] **Step 2: Remove the old stack**

```bash
git rm -r --quiet src yarn.lock .eslintrc.cjs jest.config.cjs nodemon.json
mkdir -p src
```

- [ ] **Step 3: Write the new `package.json`**

```json
{
  "name": "express-boilerplate",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Production-grade Express 5 API boilerplate",
  "license": "UNLICENSED",
  "author": { "name": "Mahaverick", "email": "support@mahaverick.com" },
  "engines": { "node": ">=24" },
  "packageManager": "pnpm@12.4.1",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "rm -rf dist && tsc && tsc-alias --resolve-full-paths",
    "start": "node dist/index.js",
    "lint": "eslint . && tsc --noEmit && tsc -p tsconfig.typecheck.json --noEmit",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write \"src/**/*.{ts,json,md}\"",
    "format:check": "prettier --check \"src/**/*.{ts,json,md}\"",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "test:coverage": "vitest run --coverage",
    "commit": "cz",
    "prepare": "husky"
  },
  "dependencies": {
    "express": "5.2.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^26.1.1",
    "tsc-alias": "^1.9.0",
    "tsx": "4.23.13",
    "typescript": "~6.0.3"
  }
}
```

Dependencies are added by the task that first needs them, so that every addition has a test proving why it is there.

**Note the absence of `express-async-handler`.** Express 5's router forwards a rejected promise from an async handler to `next(error)` automatically (verified in `expressjs/express` `router/lib/layer.js`: `handleRequest` calls `ret.then(null, error => next(error))`). `core` still carries the package as an Express 4 leftover. It is not ported.

- [ ] **Step 4: Write `tsconfig.json`, `.nvmrc`, `.npmrc`**

Use this, **not** the tsconfig in Task 0 Step 2. That one was the spike's input and the spike found it wrong twice over: `baseUrl` is removed in TS 7 and already an error in 6.0 (`TS5101`), and `moduleResolution: NodeNext` forces an explicit `.js` extension on every internal import (`TS2307`), which contradicts every code sample in this plan. These settings are core's, which run in production.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "rootDir": "./src",
    "outDir": "./dist",
    "paths": { "@/*": ["./src/*"] },
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": false,
    "noEmitOnError": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

`**/*.test.ts` is excluded so colocated tests are not emitted into `dist/` and
do not ship in the runtime image. They are still type-checked — by
`tsconfig.typecheck.json`, which Task 3 adds.

No `baseUrl` — `paths` is relative, which is what TS 7 will require, so this config is forward-compatible with the bump the spike deferred. If Node globals (`console`, `process`) fail to resolve on your pnpm layout, add `"types": ["node"]`; the spike saw this on one probe, and core sets no `types` array, so add it only if needed.

```bash
echo "24" > .nvmrc
printf 'engine-strict=true\nauto-install-peers=true\n' > .npmrc
```

- [ ] **Step 5: Install and verify the empty shell type-checks**

```bash
corepack enable
pnpm install
printf '// src/index.ts — entrypoint. Replaced in Task 6.\nexport {}\n' > src/index.ts
pnpm exec tsc --noEmit; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: rebuild on pnpm, ESM and TypeScript 7

Removes the Express 4 / CJS / yarn / Jest stack wholesale rather than
migrating it. src/ is re-derived from the production core repo in later
tasks; the pre-port inventory is kept as a note.

Express 5 forwards rejected promises from async handlers to next(error)
itself, so express-async-handler is not carried over."
```

---

## Task 2: ESLint flat config, Prettier, and the JSDoc gate

**Files:**

- Create: `eslint.config.mjs`, `prettier.config.mjs`, `.prettierignore`, `.editorconfig`
- Modify: `package.json` (devDependencies)

**Interfaces:**

- Produces: `pnpm lint` and `pnpm format:check`, both green on the empty `src/`, and a `jsdoc/require-jsdoc` rule that fails on an undocumented exported symbol.

- [ ] **Step 1: Add the lint toolchain**

```bash
pnpm add -D eslint@10.10.0 typescript-eslint@8.70.0 @eslint/js@^10.0.1 @eslint/compat@^2.1.0 \
  eslint-config-prettier@^10.1.8 eslint-plugin-import@^2.32.0 eslint-plugin-promise@^7.3.0 \
  eslint-plugin-sonarjs@4.2.0 eslint-plugin-unicorn@74.0.0 eslint-plugin-check-file@3.3.2 \
  eslint-plugin-jsdoc@64.4.0 globals@17.12.0 prettier@3.9.6 @ianvs/prettier-plugin-sort-imports@^4.7.1
```

- [ ] **Step 2: Write the failing test — an undocumented export must be rejected**

```bash
cat > src/probe.utilities.ts <<'TS'
export function undocumented(value: string): string {
  return value
}
TS
```

- [ ] **Step 3: Write `eslint.config.mjs`**

```js
// eslint.config.mjs — flat config.
//
// Ported from core/eslint.config.mjs with one deliberate difference: core
// disables ~25 unicorn rules, each justified by a count of existing
// violations ("304 — Express/Drizzle/zod call chains nest by design"). A
// greenfield repo has no such count, so only the disables with a stated
// semantic reason are carried over. The rest start ON.
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import checkFile from 'eslint-plugin-check-file'
import jsdoc from 'eslint-plugin-jsdoc'
import promise from 'eslint-plugin-promise'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  sonarjs.configs.recommended,
  unicorn.configs.recommended,
  promise.configs['flat/recommended'],
  jsdoc.configs['flat/recommended-typescript'],
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'check-file': checkFile },
    rules: {
      // Types live in TypeScript. Repeating them in the comment creates a
      // second source of truth that drifts, so descriptions are required and
      // types are not.
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns-type': 'off',
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/no-undefined-types': 'error',

      // Secrets are read in exactly one place.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from @/configs/env.config, not process.env. See spec §5.1.',
        },
      ],

      'check-file/filename-naming-convention': [
        'error',
        {
          'src/controllers/**/*.ts': '*.controller',
          'src/repositories/**/*.ts': '*.repository',
          'src/services/**/*.ts': '*.service',
          'src/validators/**/*.ts': '*.validators',
          'src/middlewares/**/*.ts': '*.middleware',
          'src/database/models/**/*.ts': '*.model',
          'src/utilities/**/*.ts': '*.utilities',
          'src/constants/**/*.ts': '*.constants',
          'src/configs/**/*.ts': '*.config',
        },
      ],
      // NO third options object. `{ ignoreMiddleExtensions: true }` strips the
      // very `.controller`/`.service`/... segment the pattern matches on, which
      // makes the rule unsatisfiable — `user.controller.ts` and `user.ts` are
      // both rejected with the same message. Verified live on 2026-09-14.
      'check-file/folder-naming-convention': ['error', { 'src/**/': 'KEBAB_CASE' }],
    },
  },
  {
    // env.config.ts is the one module allowed to read process.env — it is the
    // module whose whole job is to parse it.
    files: ['src/configs/env.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      // Test filenames carry a middle extension (sanity.utilities.test.ts),
      // which makes the naming pattern ambiguous under ignoreMiddleExtensions.
      // core disables the rule for tests for the same reason.
      'check-file/filename-naming-convention': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'no-restricted-properties': 'off',
    },
  },
  prettier
)
```

- [ ] **Step 4: Run lint and verify the probe fails**

```bash
pnpm exec eslint src/probe.utilities.ts
```

Expected: FAIL with `jsdoc/require-jsdoc` — "Missing JSDoc comment".

- [ ] **Step 5: Document the probe and verify it passes**

```ts
/**
 * Echo a value back unchanged.
 * @param value - The value to echo.
 * @returns The same value.
 */
export function undocumented(value: string): string {
  return value
}
```

```bash
pnpm exec eslint src/probe.utilities.ts; echo "exit=$?"
```

Expected: `exit=0`. The gate rejects undocumented exports and accepts documented ones with no type tags.

- [ ] **Step 6: Write `prettier.config.mjs` and delete the probe**

```js
// prettier.config.mjs
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'es5',
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: ['<BUILTIN_MODULES>', '<THIRD_PARTY_MODULES>', '^@/(.*)$', '^[./]'],
}
```

```bash
rm src/probe.utilities.ts
printf 'dist\ncoverage\npnpm-lock.yaml\n' > .prettierignore
pnpm lint; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: add ESLint 10 flat config with an enforced JSDoc gate

JSDoc was already a fleet convention (84% of core's files) but was
enforced in no repo. require-jsdoc runs publicOnly with descriptions
required and types off, since TypeScript already carries them.

no-restricted-properties bans process.env everywhere except env.config."
```

---

## Task 3: Vitest 5 harness with the coverage gate

**Files:**

- Create: `vitest.config.ts`, `tests/helpers/setup-global.ts`, `.env.test`, `.env.test.example`
- Modify: `package.json`

**Interfaces:**

- Produces: `pnpm test` and `pnpm test:coverage`; coverage below 80% exits non-zero.

- [ ] **Step 1: Add Vitest**

```bash
pnpm add -D vitest@5.0.0 @vitest/coverage-v8@^5.0.0 @vitest/ui@^5.0.0 supertest@7.2.2 @types/supertest@^7.2.0
```

- [ ] **Step 2: Make `tests/` lintable — `tsconfig.typecheck.json`**

Do this FIRST, before writing any test file. `eslint.config.mjs` uses
type-aware rules (`recommendedTypeChecked`), and that block has no `files`
scope, so it applies repo-wide — but `tsconfig.json` includes only `src/**`.
Linting anything under `tests/` therefore dies with a fatal parse error, not a
lint finding:

```
0:0  error  Parsing error: tests/unit/probe.test.ts was not found by the
project service. Consider either including it in the tsconfig.json or
including it in allowDefaultProject
```

Verified live on 2026-09-15. Without this step, `pnpm lint` fails on every file
this task creates.

**Do not fix it by adding `tests/**` to `tsconfig.json`'s `include`.** That file
is the BUILD config: it emits to `dist/` under `rootDir: ./src`, so widening it
produces a flood of TS6059 "not under rootDir" errors instead of type checking —
the reference repo measured 354 of them doing exactly this. Create a second
project instead:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Then point the type-aware parser at it, replacing `projectService: true` in
`eslint.config.mjs`:

```js
    parserOptions: {
      // tsconfig.json covers src/ only — it is the build config. This wider
      // project is what lets type-aware rules see tests/ as well; without it
      // eslint fatals on every test file.
      project: ['./tsconfig.typecheck.json'],
      tsconfigRootDir: import.meta.dirname,
    },
```

Verify both directions before moving on:

```bash
mkdir -p tests/unit && printf 'export const x = 1
' > tests/unit/probe.test.ts
pnpm exec eslint tests/unit/probe.test.ts; echo "tests/ lintable -> exit=$?"   # expect 0, NOT a parsing error
rm -rf tests/unit
pnpm lint; echo "clean tree -> exit=$?"                                        # expect 0
```

This same file is the second half of `pnpm lint`. Update the script now:

```json
"lint": "eslint . && tsc --noEmit && tsc -p tsconfig.typecheck.json --noEmit"
```

The second `tsc` is the ONLY thing that gives `tests/` raw type diagnostics —
`tsconfig.json` covers `src/` only, so without it a type error in a test file is
invisible to every gate except type-aware eslint.

**There is deliberately no typecheck ratchet.** The reference repo has one
because it froze 452 pre-existing type errors across 106 test files, and needed
a gate that failed only on _new_ debt. A greenfield repo inherits none of that,
so a ratchet here would be machinery guarding a number that is already zero —
and a ratchet that can never trip is worse than none, because it looks like a
gate. Fail on any error instead.

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/helpers/setup-global.ts'],
    alias: [
      { find: '@/tests', replacement: path.resolve(dirname, './tests') },
      { find: '@', replacement: path.resolve(dirname, './src') },
    ],
    pool: 'forks',
    // Pinned, not left to the host's core count. Each worker opens its own
    // Postgres pool, so the connection ceiling is maxForks x pool.max. At 8 x 2
    // that is 16 against Postgres's default max_connections of 100. Leaving it
    // unset made the headroom a coincidence of whichever CI runner ran the job.
    poolOptions: { forks: { maxForks: 8 } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // `include` is what makes the threshold mean anything. Without it only
      // files that some test happens to import are counted, so an entire
      // untested module ships and the summary still reads 100%. Verified: a new
      // utility with an uncovered branch did not appear in the report at all.
      include: ['src/**/*.ts'],
      exclude: [
        'coverage/**',
        'dist/**',
        '**/*.d.ts',
        'tests/**',
        '**/*.test.ts',
        '**/migrations/**',
        '**/seeders/**',
        // NOT '**/*.config.ts'. `check-file` forces every file under
        // src/configs/** to be named *.config.ts, so that glob would make the
        // whole directory — env parsing and its branches included —
        // permanently exempt by construction. Root-level tool configs are
        // already outside `include`.
        // The entrypoint only wires signals and calls process.exit; it is
        // exercised for real in Task 6 Step 7. server.ts is deliberately NOT
        // excluded — Task 6 tests it against an ephemeral port.
        'src/index.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
```

- [ ] **Step 4: Write the test-environment loader**

```ts
// tests/helpers/setup-global.ts
//
// WHY THIS EXISTS. Precedence is: real process env > .env.test.local
// (git-ignored, per-developer) > .env.test (committed, mirrors the CI env
// block). core learned this the hard way: loading the developer's own .env
// under test let 74 of 98 local keys leak into the suite, including live
// credentials, and made tests pass locally that failed in CI. A new test
// variable must be added to BOTH .env.test and .github/workflows/ci.yml.
import fs from 'node:fs'
import path from 'node:path'

const load = (file: string): void => {
  const full = path.resolve(process.cwd(), file)
  if (!fs.existsSync(full)) return
  // Split on \r?\n, not '\n'. A CRLF file leaves a trailing \r on every line,
  // and the key/value regex then matches NOTHING — `.` excludes \r and `$`
  // without the `m` flag wants true end-of-string — so each line is silently
  // skipped rather than mis-trimmed. A CRLF .env.test.local would load zero
  // variables and report no error.
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match?.[1]) continue
    if (process.env[match[1]] !== undefined) continue
    process.env[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
}

load('.env.test.local')
load('.env.test')
```

- [ ] **Step 5: Write a test that proves the coverage gate bites**

```ts
// src/utilities/sanity.utilities.test.ts
import { describe, expect, it } from 'vitest'
import { identity } from '@/utilities/sanity.utilities'

describe('identity', () => {
  it('returns its argument', () => {
    expect(identity('x')).toBe('x')
  })
})
```

- [ ] **Step 6: Run it and verify it fails**

```bash
pnpm test
```

Expected: FAIL — `Cannot find module '@/utilities/sanity.utilities'`.

- [ ] **Step 7: Implement the module**

```ts
// src/utilities/sanity.utilities.ts
//
// A single trivially-testable export, so the harness itself is under test
// before any real module depends on it. Deleted in plan B2 once real
// utilities are ported.

/**
 * Return the supplied value unchanged.
 * @param value - The value to return.
 * @returns The same value.
 */
export function identity<T>(value: T): T {
  return value
}
```

- [ ] **Step 8: Verify test and coverage both pass**

```bash
pnpm test; echo "test exit=$?"
pnpm test:coverage; echo "coverage exit=$?"
```

Expected: both `exit=0`, and the coverage table shows 100% for `sanity.utilities.ts`.

- [ ] **Step 9: Add a regression test for the lint gates**

Task 2's gates broke silently three separate times — `import-x/no-cycle` was
inert twice, and `check-file` rejected every filename including correct ones.
Each was found by a hand-run probe that was then deleted, so nothing in the repo
would catch a recurrence. Now that there is a test runner, pin them:

```ts
// tests/unit/lint-gates.test.ts
//
// These assert that the lint gates FIRE, not that the config file contains
// certain keys. A gate that is configured but inert lints green while enforcing
// nothing, which is worse than having no gate — it happened three times while
// Task 2 was being written.
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// `ignore: false` so the committed cycle fixtures under tests/fixtures/ can be
// linted deliberately here while `pnpm lint` keeps skipping them.
const eslint = new ESLint({ cwd: process.cwd(), ignore: false })

const ruleIdsFor = async (filePath: string, source: string): Promise<string[]> => {
  const [result] = await eslint.lintText(source, { filePath })
  return (result?.messages ?? []).map((message) => message.ruleId ?? '')
}

describe('lint gates actually fire', () => {
  it('rejects an undocumented export', async () => {
    const ids = await ruleIdsFor(
      'src/utilities/probe.utilities.ts',
      'export function p(): string { return "x" }\n'
    )
    expect(ids).toContain('jsdoc/require-jsdoc')
  })

  it('accepts a documented export', async () => {
    const ids = await ruleIdsFor(
      'src/utilities/probe.utilities.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('jsdoc/require-jsdoc')
  })

  it('accepts a correctly named file in a governed directory', async () => {
    const ids = await ruleIdsFor(
      'src/controllers/user.controller.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('check-file/filename-naming-convention')
  })

  it('rejects a wrongly named file in a governed directory', async () => {
    const ids = await ruleIdsFor(
      'src/controllers/user.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).toContain('check-file/filename-naming-convention')
  })

  it('allows process.env inside env.config and blocks it elsewhere', async () => {
    const source = 'export const x = process.env.FOO\n'
    expect(await ruleIdsFor('src/configs/env.config.ts', source)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/services/other.service.ts', source)).toContain(
      'no-restricted-properties'
    )
  })

  // no-cycle CANNOT be tested through lintText. import-x builds its ExportMap by
  // reading real files with fs.readFileSync, and the rule bails out when the
  // filename is the synthetic `<text>`. It needs files that exist on disk, which
  // is why these two fixtures are committed rather than generated inline.
  it('rejects a circular import between real files', async () => {
    const results = await eslint.lintFiles(['tests/fixtures/lint-cycle/a.ts'])
    const ids = (results[0]?.messages ?? []).map((message) => message.ruleId ?? '')
    expect(ids).toContain('import-x/no-cycle')
  })
})
```

Commit the two fixtures it needs. They import each other, which is the whole point:

```ts
// tests/fixtures/lint-cycle/a.ts — deliberately circular. See lint-gates.test.ts.
import { b } from './b'

export const a = (): string => b()
```

```ts
// tests/fixtures/lint-cycle/b.ts — deliberately circular. See lint-gates.test.ts.
import { a } from './a'

export const b = (): string => a()
```

Add `tests/fixtures/**` to the `ignores` array in `eslint.config.mjs`, so `pnpm lint` skips these two files while the test lints them deliberately via `ignore: false`. Without that, the fixtures fail the repo's own lint run — which would be a self-inflicted version of exactly the bug they exist to catch.

Run: `pnpm test tests/unit/lint-gates.test.ts`
Expected: PASS, 7 tests. The `check-file` case is the one that would have caught Task 2's unsatisfiable-pattern bug; the `no-cycle` case is the one that would have caught its two blindness bugs.

- [ ] **Step 10: Commit**

```bash
printf 'NODE_ENV=test\n' > .env.test
cp .env.test .env.test.example
git add -A
git commit -m "test: add Vitest 5 harness with an 80% coverage gate

pulse has no coverage configuration at all and core's thresholds are not
run in CI. Here vitest run --coverage is a gate, not a report.

Test env precedence is process env > .env.test.local > .env.test, so a
local run sees what CI sees."
```

---

## Task 4: Fail-fast environment validation

This is the task that fixes the failure recorded in spec §1.1: `ms(process.env.REFRESH_TOKEN_EXPIRY)` throwing `val=undefined` at import time, which stops one of the repo's two test suites from running at all.

**Files:**

- Create: `src/configs/env.config.ts`, `tests/unit/configs/env.config.test.ts`, `src/scripts/generate-env-example.ts`, `.env.example`
- Modify: `.env.test`, `package.json`

**Interfaces:**

- Produces:
  - `parseEnv(source: Record<string, unknown>): Env` — pure, throws `Error` with a prettified message listing **every** problem.
  - `getEnv(): Env` — memoised parse of `process.env`, frozen.
  - `type Env` — the inferred type every later module imports.

- [ ] **Step 1: Add Zod and write the failing test**

```bash
pnpm add zod@4.6.5
```

```ts
// tests/unit/configs/env.config.test.ts
import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/configs/env.config'

const valid = {
  NODE_ENV: 'test',
  APP_PORT: '4040',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
}

describe('parseEnv', () => {
  it('coerces APP_PORT from string to number', () => {
    expect(parseEnv(valid).APP_PORT).toBe(4040)
  })

  it('defaults APP_PORT when absent', () => {
    const { APP_PORT, ...rest } = valid
    expect(parseEnv(rest).APP_PORT).toBe(4040)
  })

  it('names every missing key in one message, not just the first', () => {
    const { DATABASE_URL, REDIS_URL, ...rest } = valid
    let message = ''
    try {
      parseEnv(rest)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
  })

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('rejects a malformed URL', () => {
    expect(() => parseEnv({ ...valid, APP_URL: 'not-a-url' })).toThrow(/APP_URL/)
  })

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(valid))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm test tests/unit/configs/env.config.test.ts
```

Expected: FAIL — `Cannot find module '@/configs/env.config'`.

- [ ] **Step 3: Implement `src/configs/env.config.ts`**

```ts
// src/configs/env.config.ts
//
// WHY THIS EXISTS. Every module reads configuration from this object, never
// from process.env — the eslint rule no-restricted-properties enforces it.
//
// Reading process.env at the point of use means a missing variable surfaces
// as `undefined` far from its cause. This repo's own history is the argument:
// before this rewrite, `ms(process.env.REFRESH_TOKEN_EXPIRY)` threw
// "val is not a non-empty string or a valid number" at module-import time,
// which stopped auth.controller.test.ts from running at all — so the backend
// had exactly one passing test and the reason looked like a bug in `ms`.
//
// Parsing once, at boot, turns that into one readable list of what is wrong.
import { config } from 'dotenv'
import { z } from 'zod'

// Load `.env` here — this is the one module allowed to touch process.env, so it
// is the one place the file should be read. Without this the whole onboarding
// flow is inert: `.env.example` is generated, the README says to copy it, and
// nothing ever reads the result.
//
// NOT under Vitest. The test environment is assembled by
// tests/helpers/setup-global.ts (process env > .env.test.local > .env.test).
// Loading `.env` as well lets a developer's local config leak into the suite,
// which makes tests pass on one machine and fail on another for reasons that
// look nothing like configuration. `quiet` suppresses dotenv's startup banner,
// which otherwise corrupts any command whose stdout is machine-readable.
if (!process.env.VITEST) {
  config({ quiet: true })
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(4040),

  // NOT z.httpUrl(). Its hostname check requires a dotted TLD, so it rejects
  // `http://localhost:4040` AND `http://postgres:5432` — the docker-compose
  // service hostname. Both are the normal case here, so httpUrl() would make
  // local dev and the compose stack unconfigurable. Verified 2026-09-15.
  /** Public origin of this API. Used for OAuth callbacks and email links. */
  APP_URL: z.url({ protocol: /^https?$/ }),
  /** Public origin of the frontend. Used for CORS and redirect targets. */
  WEB_URL: z.url({ protocol: /^https?$/ }),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),

  /** Absent means tracing is disabled; the SDK is never started. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
})

/** The validated, frozen environment every module consumes. */
export type Env = Readonly<z.infer<typeof EnvSchema>>

/**
 * Validate an environment source and return it typed and frozen.
 * @param source - Raw key/value pairs, normally `process.env`.
 * @returns The parsed environment.
 * @throws Error listing every invalid or missing variable at once.
 */
export function parseEnv(source: Record<string, unknown>): Env {
  // Drop empty-string values before validating. A .env produced by copying
  // .env.example leaves `KEY=` lines behind, and '' is not the same as absent
  // to an `.optional()` field — it fails as a malformed URL instead. Since
  // dotenv cannot express "unset" any other way, an empty value means absent.
  // Required fields are unaffected: they still fail, now with "missing" rather
  // than a confusing format error.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
  const result = EnvSchema.safeParse(present)

  if (!result.success) {
    // prettifyError renders every issue with its path, so a developer fixes
    // all of them in one pass instead of one per restart.
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }

  return Object.freeze(result.data)
}

/**
 * Validate only `DATABASE_URL`, for tools that need nothing else.
 *
 * `drizzle-kit` loads `drizzle.config.ts` in its own process to generate a
 * migration. Routing that through `getEnv()` would require the full
 * application environment — JWT secrets, session secret — to write a SQL file.
 * The validation rule stays single-sourced: this reuses the same field schema.
 * @returns The validated database URL.
 * @throws Error when DATABASE_URL is missing or malformed.
 */
export function getDatabaseUrl(): string {
  const result = EnvSchema.pick({ DATABASE_URL: true }).safeParse(process.env)
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }
  return result.data.DATABASE_URL
}

let cached: Env | undefined

/**
 * Parse `process.env` once and memoise the result.
 *
 * Lazy on purpose: a module-scope `parseEnv(process.env)` would throw during
 * import resolution, which is the failure mode this module exists to remove.
 * @returns The validated environment.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm test tests/unit/configs/env.config.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Generate `.env.example` from the schema so the two cannot drift**

```ts
// src/scripts/generate-env-example.ts
//
// Inside src/ on purpose: it imports `@/configs/env.config`, and at the
// repo-root scripts/ path it would sit outside tsconfig's `include`, so
// `tsc --noEmit` would skip it and eslint's projectService would error on it.
// core uses src/scripts/ for exactly this class of tool.
//
// .env.example is generated, never hand-edited. A hand-maintained example
// file drifts from the schema within weeks, and the drift is invisible until
// someone's first run fails.
import fs from 'node:fs'
import { z } from 'zod'
import { EnvSchemaShape } from '@/configs/env.config'

const lines: string[] = ['# Generated by `pnpm env:example`. Do not edit by hand.', '']

for (const [key, schema] of Object.entries(EnvSchemaShape)) {
  const json = z.toJSONSchema(schema as z.ZodType, { target: 'openapi-3.0', io: 'input' })
  const description =
    typeof json === 'object' && 'description' in json ? String(json.description) : ''
  const fallback = typeof json === 'object' && 'default' in json ? String(json.default) : ''
  if (description) lines.push(`# ${description}`)
  // Optional keys are emitted commented out. Leaving `KEY=` uncommented makes
  // `cp .env.example .env` produce a file that looks complete and is not — the
  // reader cannot tell "no value needed" from "fill this in".
  const optional =
    typeof json === 'object' && json !== null && !('default' in json) && !requiredKeys.has(key)
  lines.push(`${optional ? '# ' : ''}${key}=${fallback}`, '')
}

fs.writeFileSync('.env.example', lines.join('\n'))
```

Export the shape from `env.config.ts` so the script can walk it:

```ts
/** The schema's field map, exported so `pnpm env:example` can walk it. */
export const EnvSchemaShape = EnvSchema.shape
```

Add the script:

```json
"env:example": "tsx src/scripts/generate-env-example.ts"
```

- [ ] **Step 6: Generate it and pin the test env**

```bash
pnpm env:example && cat .env.example
```

Then append the required keys to `.env.test` so later tasks' tests can call `getEnv()`:

```bash
cat >> .env.test <<'ENV'
APP_PORT=4040
APP_URL=http://localhost:4040
WEB_URL=http://localhost:5173
DATABASE_URL=postgres://test:test@localhost:5432/boilerplate_test
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=test-access-secret-that-is-long-enough-32
JWT_REFRESH_SECRET=test-refresh-secret-that-is-long-enough-3
SESSION_SECRET=test-session-secret-that-is-long-enough-1
ENV
cp .env.test .env.test.example
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: validate the environment once, at boot, with Zod

Fixes the failure recorded in the spec's before-state: ms() threw on an
unset REFRESH_TOKEN_EXPIRY at import time, so one of two test suites
could not run and the backend had a single passing test.

parseEnv reports every problem at once via z.prettifyError. getEnv is
lazy because a module-scope parse would throw during import resolution —
the exact failure mode being removed. .env.example is generated."
```

---

## Task 5: Docker Compose and the database client

**Files:**

- Create: `docker-compose.yml`, `src/services/database.service.ts`, `src/services/redis.service.ts`, `tests/integration/services/database.service.test.ts`, `otel-collector.yaml`
- Modify: `package.json`

**Interfaces:**

- Produces:
  - `db` — the Drizzle client, and `sql` — the raw `postgres` client.
  - `closeDatabase(): Promise<void>` — used by graceful shutdown in Task 6.
  - `getRedis(): RedisClientType` and `closeRedis(): Promise<void>`.
  - `isDatabaseReachable(): Promise<boolean>` and `isRedisReachable(): Promise<boolean>` — consumed by the readiness probe in Task 6.

- [ ] **Step 0: Add `dotenv` and wire it into `env.config.ts`**

```bash
pnpm add dotenv
```

Nothing in this repo reads `.env` until this lands, which makes the generated
`.env.example` and the README's `cp .env.example .env` step decorative. See the
`env.config.ts` snippet in Task 4 for placement and for why it must be skipped
under Vitest.

Verify: `cp .env.example .env`, fill only the required secrets, then
`pnpm dev` must boot without any variable being exported by hand.

- [ ] **Step 1: Add the clients**

```bash
pnpm add drizzle-orm@0.45.2 postgres@^3.4.9 redis@6.2.1
pnpm add -D drizzle-kit@0.31.10
```

`drizzle-kit` goes in **devDependencies**, not dependencies. `core` has it in dependencies; the production image migrates with `node dist/database/migrate.js` and never invokes drizzle-kit, so it is a build-time tool. Spec §14.

- [ ] **Step 2: Replace the stale drizzle config and un-ignore it in eslint**

`drizzle.config.ts` is a leftover from the old Express 4 stack — it points at
schema paths that no longer exist. Task 2 added it to `eslint.config.mjs`'s
`ignores` purely so `eslint .` could run while the file was orphaned and outside
tsconfig's `include`. Now that this task lands drizzle for real, both halves get
fixed together:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'
import { getDatabaseUrl } from '@/configs/env.config'

export default defineConfig({
  schema: './src/database/models/*.model.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  // getDatabaseUrl(), not getEnv(). drizzle-kit loads this file in its own
  // process, and getEnv() validates the WHOLE schema — so `drizzle-kit
  // generate` would demand JWT and session secrets just to write a SQL file.
  // Verified: it failed on JWT_REFRESH_SECRET and SESSION_SECRET.
  dbCredentials: { url: getDatabaseUrl() },
  strict: true,
  verbose: true,
})
```

Then **remove `'drizzle.config.ts'` from the `ignores` array** in
`eslint.config.mjs`, and add it to `tsconfig.typecheck.json`'s `include` so the
type-aware parser can see it:

```json
  "include": ["src/**/*", "tests/**/*", "drizzle.config.ts"]
```

Verify: `pnpm exec eslint drizzle.config.ts` produces lint results rather than a
parsing error, and `pnpm lint` still exits 0. Leaving the ignore in place would
mean the one config file that decides where migrations are written is the only
file in the repo nobody lints.

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
# docker-compose.yml — the local infrastructure the app requires to boot.
#
# Postgres is pinned to 18 because the migrations use uuidv7() as a column
# default, which is built in from 18. On 17 or older the migration aborts
# with "function uuidv7() does not exist" unless an extension is installed.
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: boilerplate
      POSTGRES_PASSWORD: boilerplate
      POSTGRES_DB: boilerplate
    # 5433, not 5432. A developer with Homebrew postgres already listening on
    # 5432 wins the bind — Docker's wildcard bind loses to a specific-address
    # one — and the failure is confusing rather than obvious. Verified on this
    # machine. The Redis case is worse: any Redis answers PING, so the suite
    # passes against the developer's personal instance while testing nothing.
    ports: ['5433:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U boilerplate']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7.2-alpine
    ports: ['6380:6379'] # see the postgres port comment
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ['--config=/etc/otel/config.yaml']
    volumes: ['./otel-collector.yaml:/etc/otel/config.yaml:ro']
    ports: ['4318:4318']

  mailpit:
    image: axllent/mailpit:latest
    ports: ['1025:1025', '8025:8025']

volumes:
  pgdata:
```

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: normal
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
    logs: { receivers: [otlp], exporters: [debug] }
```

- [ ] **Step 4: Write the failing integration test**

```ts
// tests/integration/services/database.service.test.ts
import { afterAll, describe, expect, it } from 'vitest'
import { closeDatabase, isDatabaseReachable, sql } from '@/services/database.service'

describe('database.service', () => {
  afterAll(async () => {
    await closeDatabase()
  })

  it('connects and answers a trivial query', async () => {
    const rows = await sql`select 1 as ok`
    expect(rows[0]?.ok).toBe(1)
  })

  it('reports health', async () => {
    expect(await isDatabaseReachable()).toBe(true)
  })
})
```

- [ ] **Step 5: Bring the stack up and verify the test fails**

```bash
docker compose up -d
docker compose ps
pnpm test tests/integration/services/database.service.test.ts
```

Expected: FAIL — `Cannot find module '@/services/database.service'`.

- [ ] **Step 6: Implement `src/services/database.service.ts`**

```ts
// src/services/database.service.ts
//
// One postgres client for the process. `postgres` pools internally, so a
// second client means a second pool and double the configured connection
// budget — which only shows up under load, as "too many connections".
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getEnv } from '@/configs/env.config'

const env = getEnv()

/** Raw SQL client. Prefer `db` unless you need untyped SQL. */
export const sql = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'test' ? 2 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Transaction pooling breaks prepared statements; off is the portable default.
  prepare: false,
})

/** Drizzle client. The query interface every repository uses. */
export const db = drizzle(sql)

/**
 * Check that the database answers.
 *
 * Named as a predicate, not `pingDatabase`, because
 * `unicorn/consistent-boolean-name` requires boolean-returning functions to
 * read as questions — and satisfying the rule is better than suppressing it in
 * a file every derived project copies.
 * @returns True when a trivial query succeeds.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await sql`select 1`
    return true
  } catch {
    return false
  }
}

/**
 * Close the pool. Called by graceful shutdown; safe to call twice.
 * @returns Resolves once the pool is drained.
 */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 })
}
```

- [ ] **Step 7: Verify it passes, then implement Redis the same way**

```bash
pnpm test tests/integration/services/database.service.test.ts
```

Expected: PASS. Then write the Redis client:

```ts
// src/services/redis.service.ts
//
// One connection for the process, created lazily. Eager connection at import
// time would make every unit test that transitively imports a repository open
// a socket — and fail on a machine with no Redis running.
import { createClient, type RedisClientType } from 'redis'
import { getEnv } from '@/configs/env.config'

let client: RedisClientType | undefined

// Once shutdown has run, the client must stay closed. Without this flag
// `getRedis()` lazily rebuilds a client on the next call, so
// `isRedisReachable()` answers `true` after `closeRedis()` and a readiness
// probe firing mid-teardown silently reopens a socket the shutdown just closed.
// Verified: the assertion "unreachable after close" fails without it. Postgres
// gets this for free — `sql.end()` makes later queries reject — so this is the
// flag that makes Redis behave the same way.
let closed = false

/**
 * Get the shared Redis client, connecting on first use.
 * @returns A connected client.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (closed) {
    throw new Error('Redis client is closed; the process is shutting down')
  }
  if (!client) {
    client = createClient({
      url: getEnv().REDIS_URL,
      socket: {
        connectTimeout: 5000,
        // Give up rather than retry forever. node-redis's DEFAULT strategy
        // reconnects indefinitely and `connect()` never rejects — so with Redis
        // down, `/health/ready` hangs instead of answering 503. A readiness
        // probe that hangs is worse than one that fails: the orchestrator
        // learns nothing, exactly when something is wrong. Returning an Error
        // from the strategy is what makes the promise reject.
        reconnectStrategy: (retries) =>
          retries > 3 ? new Error('Redis unreachable') : Math.min(retries * 100, 1000),
      },
    })
    client.on('error', (error) => console.error('redis error', error))
    await client.connect()
  }
  return client
}

/**
 * Check that Redis answers.
 * @returns True when PING succeeds. False once the client has been closed.
 */
export async function isRedisReachable(): Promise<boolean> {
  if (closed) return false
  try {
    return (await (await getRedis()).ping()) === 'PONG'
  } catch {
    return false
  }
}

/**
 * Close the connection. Called by graceful shutdown; safe to call twice.
 * @returns Resolves once closed.
 */
export async function closeRedis(): Promise<void> {
  closed = true
  if (!client) return
  await client.quit()
  client = undefined
}
```

And its test:

```ts
// tests/integration/services/redis.service.test.ts
import { afterAll, describe, expect, it } from 'vitest'
import { closeRedis, isRedisReachable } from '@/services/redis.service'

describe('redis.service', () => {
  afterAll(async () => {
    await closeRedis()
  })

  it('answers a ping', async () => {
    expect(await isRedisReachable()).toBe(true)
  })

  it('is safe to close twice', async () => {
    await closeRedis()
    await expect(closeRedis()).resolves.toBeUndefined()
  })
})
```

```bash
pnpm test tests/integration/services/redis.service.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 8: Guard the port move with a test, not a comment**

The reason the stack moved to 5433/6380 was that a native Redis silently answers
PING, so the suite could pass against the developer's own instance. That proof
was a one-off manual check. Nothing stops someone "tidying" the ports back to
the defaults, and the failure would again be silent. Pin it:

```ts
// tests/integration/services/connection-target.test.ts
//
// This asserts WHERE we connect, not that connecting works. The stack uses
// non-default host ports because a developer's own Postgres/Redis occupies
// 5432/6379 — and the Redis case fails silently, since any Redis answers PING.
// If someone reverts the ports, this fails loudly instead.
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'

describe('connections target the compose stack, not a local service', () => {
  it('uses the non-default Postgres host port', () => {
    expect(new URL(getEnv().DATABASE_URL).port).toBe('5433')
  })

  it('uses the non-default Redis host port', () => {
    expect(new URL(getEnv().REDIS_URL).port).toBe('6380')
  })
})
```

Also add the missing lifecycle assertion, which is what exposed the Redis bug:

```ts
it('reports unreachable once closed, and does not silently reopen', async () => {
  expect(await isRedisReachable()).toBe(true)
  await closeRedis()
  expect(await isRedisReachable()).toBe(false)
  await expect(closeRedis()).resolves.toBeUndefined() // idempotent
})
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add Postgres and Redis clients behind a compose stack

Postgres pinned to 18 for built-in uuidv7(). One client per process —
a second means a second pool and double the connection budget.

drizzle-kit is a devDependency: the production image migrates with node
dist/database/migrate.js and never invokes it. core has it in
dependencies; carried as a fix, not copied."
```

---

## Task 6: Split the app — `app.ts`, `server.ts`, `index.ts`

`core/src/index.ts` is 38k and does app construction, route mounting, worker startup, listen and shutdown in one file. The boilerplate must not teach that. Spec §5.5.

**Files:**

- Create: `src/app.ts`, `src/server.ts`, `src/middlewares/request-id.middleware.ts`, `src/middlewares/error.middleware.ts`, `src/utilities/response.utilities.ts`, `src/constants/global.constants.ts`, `tests/integration/api/health.test.ts`, `tests/unit/middlewares/error.middleware.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `getEnv()` (Task 4); `isDatabaseReachable()`, `isRedisReachable()` (Task 5).
- Produces:
  - `createApp(): Express` — no listening socket, no side effects. Every integration test in plans B2–B5 imports this.
  - `startServer(): Promise<Server>` and `gracefulShutdown(server: Server): Promise<void>`.
  - `class HttpError extends Error { statusCode: number; errors?: unknown }`.
  - `successResponse(res, data, message?, status?)` and `errorResponse(res, message, status, errors?)`.

- [ ] **Step 1: Write the failing probe tests**

```ts
// tests/integration/api/health.test.ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'

const app = createApp()

describe('health probes', () => {
  it('GET /health is shallow and does not touch the database', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
  })

  it('GET /health/ready reports each dependency', async () => {
    const response = await request(app).get('/health/ready')
    expect([200, 503]).toContain(response.status)
    expect(response.body.checks).toHaveProperty('database')
    expect(response.body.checks).toHaveProperty('redis')
  })

  it('stamps a request id on every response', async () => {
    const response = await request(app).get('/health')
    expect(response.headers['x-request-id']).toMatch(/[\da-f-]{36}/)
  })

  it('echoes a caller-supplied request id', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const response = await request(app).get('/health').set('X-Request-Id', id)
    expect(response.headers['x-request-id']).toBe(id)
  })

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(app).get('/api/v1/nope')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ success: false, statusCode: 404 })
  })

  it('forwards a rejected promise from an async handler without a wrapper', async () => {
    // Express 5 does this itself; express-async-handler is not installed.
    //
    // Built bare rather than from createApp(): Express matches in registration
    // order and createApp() has already mounted its 404 catch-all, so a route
    // added afterwards is unreachable and this would pass for the wrong reason.
    const probe = express()
    probe.get('/boom', async () => {
      throw new HttpError('deliberate', 418)
    })
    probe.use(errorHandler)
    const response = await request(probe).get('/boom')
    expect(response.status).toBe(418)
  })
})
```

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm test tests/integration/api/health.test.ts
```

Expected: FAIL — `Cannot find module '@/app'`.

- [ ] **Step 3: Allow deliberately-unused parameters, or no error handler can be written**

Express identifies an error handler by its **arity** — exactly four parameters.
The fourth is almost never used, and `@typescript-eslint/no-unused-vars` rejects
it. Verified on 2026-09-15 against the current config:

```
12:3  error  '_next' is defined but never used  @typescript-eslint/no-unused-vars
```

No `argsIgnorePattern` is configured, so the underscore convention carries no
weight. This blocks the entire task: the error handler cannot be written, and
the tempting fixes are both wrong — dropping the parameter silently turns the
handler into ordinary middleware that never sees an error, and suppressing the
rule inline puts a disable comment in a file every derived project inherits.

Add to the main rules block in `eslint.config.mjs`:

```js
      // Express detects error handlers by arity — exactly four parameters —
      // so the unused fourth is load-bearing. The underscore prefix is the
      // signal that a parameter is deliberately unused; without this the only
      // alternatives are deleting a parameter Express needs, or an inline
      // disable in every handler.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
```

Verify both directions: a parameter named `_next` lints clean, and one named
`next` that is genuinely unused is still rejected. If the second does not fire,
the rule has become a blanket suppression and that is worse than the problem.

- [ ] **Step 4: Implement the error envelope and middleware**

`errorResponse` in `src/utilities/response.utilities.ts` is the single
definition of the envelope, and it reads the correlation id off the response
itself so callers never pass it:

```ts
/**
 * Send the standard error envelope.
 *
 * The one definition of the error shape. `error.middleware` delegates here
 * rather than building the object itself — the contract every client depends
 * on must not exist in two places that can drift apart.
 * @param response - The response to write to.
 * @param message - Message safe to return to the client.
 * @param statusCode - HTTP status.
 * @param errors - Optional field-level detail.
 */
export function errorResponse(
  response: Response,
  message: string,
  statusCode: number,
  errors?: unknown
): void {
  response.status(statusCode).json({
    success: false,
    message,
    statusCode,
    ...(errors ? { errors } : {}),
    requestId: response.getHeader(REQUEST_ID_HEADER),
  })
}
```

```ts
// src/middlewares/error.middleware.ts
//
// The envelope is core's: { success, message, statusCode, errors }. RFC 9457
// problem+json is the modern standard and is the better choice for a new
// API — but switching it here would mean rewriting every ported controller
// and the frontend's interceptors, which defeats derive-and-strip. It ships
// as a recipe instead. See spec §13.
import { type NextFunction, type Request, type Response } from 'express'
import { REQUEST_ID_HEADER } from '@/middlewares/request-id.middleware'
import { errorResponse } from '@/utilities/response.utilities'

/** An error carrying the HTTP status the client should receive. */
export class HttpError extends Error {
  /**
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param errors - Optional field-level detail, e.g. from a validator.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly errors?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Terminal error handler. Must be registered last and must take four
 * parameters — Express identifies error handlers by arity, so dropping the
 * unused `next` silently turns this into ordinary middleware.
 * @param error - The thrown or forwarded error.
 * @param request - The request.
 * @param response - The response.
 * @param _next - Required for Express to recognise the arity.
 */
export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction
): void {
  const httpError = error instanceof HttpError ? error : undefined
  const statusCode = httpError?.statusCode ?? 500

  // A 500 means we got it wrong, so the real message stays server-side.
  const message =
    statusCode >= 500 ? 'Internal server error' : ((error as Error)?.message ?? 'Error')

  // A 5xx is masked to the client — and must NOT therefore be silent. Without
  // this the server's own failures vanish: the caller sees "Internal server
  // error" and nothing anywhere records what actually happened. Logging the
  // request id alongside it is what makes a user's report traceable to a line.
  if (statusCode >= 500) {
    console.error(`[${String(response.getHeader(REQUEST_ID_HEADER))}]`, error)
  }

  // Delegate to errorResponse rather than building the envelope here. The shape
  // was previously defined in both places, which is two sources of truth for
  // the contract every client depends on.
  errorResponse(response, message, statusCode, httpError?.errors)
}
```

- [ ] **Step 5: Implement `request-id.middleware.ts` and `app.ts`**

```ts
// src/middlewares/request-id.middleware.ts
//
// Every response carries an id, and a caller-supplied one is honoured so a
// trace survives the hop from the frontend. This runs first in the chain:
// the error handler reads the header back off the response, so anything
// registered before this would produce errors with no id.
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response } from 'express'

/** Header carrying the correlation id in both directions. */
export const REQUEST_ID_HEADER = 'X-Request-Id'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * Attach a correlation id to the request and response.
 *
 * A caller-supplied id is validated before it is echoed — reflecting an
 * arbitrary header into a response is how a log-injection bug starts.
 * @param request - The request.
 * @param response - The response.
 * @param next - Passes control on.
 */
export function requestId(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.get(REQUEST_ID_HEADER)
  const id = supplied && UUID_PATTERN.test(supplied) ? supplied : randomUUID()

  request.id = id
  response.setHeader(REQUEST_ID_HEADER, id)
  next()
}
```

Declare the augmentation once, in `src/types/express.d.ts`:

```ts
declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by requestId middleware. */
      id: string
    }
  }
}

export {}
```

```ts
// src/app.ts
//
// Builds the app and returns it. No listen, no workers, no side effects —
// that is what makes supertest able to import it, and it is why this is a
// separate file from server.ts. core's single 38k index.ts is the thing this
// split exists to avoid.
import express, { type Express } from 'express'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { isDatabaseReachable } from '@/services/database.service'
import { isRedisReachable } from '@/services/redis.service'

/**
 * Build the Express application.
 * @returns A configured app with no listening socket.
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(requestId)
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false }))

  // Liveness: deliberately shallow. If this checked the database, a transient
  // blip would make the orchestrator restart a healthy process — which is how
  // a slow query becomes an outage.
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', uptime: process.uptime() })
  })

  // Readiness: deep. Safe to fail — it only removes the pod from rotation.
  app.get('/health/ready', async (_request, response) => {
    const [database, redis] = await Promise.all([isDatabaseReachable(), isRedisReachable()])
    const ready = database && redis
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      checks: { database, redis },
    })
  })

  app.use((_request, _response, next) => {
    next(new HttpError('Not found', 404))
  })
  app.use(errorHandler)

  return app
}
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
pnpm test tests/integration/api/health.test.ts
```

Expected: PASS, 6 tests. The last one proves Express 5 forwards async rejections with no wrapper installed.

- [ ] **Step 7: Implement `server.ts` and `index.ts`**

```ts
// src/server.ts — owns the socket and the shutdown sequence.
import { type Server } from 'node:http'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { closeDatabase } from '@/services/database.service'
import { closeRedis } from '@/services/redis.service'

/**
 * Start listening.
 *
 * The port is a parameter, not read straight from the environment, because
 * `getEnv()` memoises: `database.service.ts` calls it at module scope, so
 * importing this module has already frozen the parsed environment before any
 * test body runs. A test that sets `process.env.APP_PORT` and then calls
 * `startServer()` would silently bind the configured port instead of an
 * ephemeral one, and would pass while testing the wrong thing.
 * @param port - Port to bind. Defaults to the configured one. Pass 0 to let the
 *   OS pick a free port, which is what makes the lifecycle test safe in parallel.
 * @returns The listening server.
 */
export function startServer(port: number = getEnv().APP_PORT): Server {
  return createApp().listen(port, () => {
    console.info(`listening on :${port}`)
  })
}

/**
 * Stop accepting connections, drain, then close dependencies.
 *
 * Order matters: the socket closes first so no new request can arrive and
 * find a closed pool. The timer is the backstop for a connection that never
 * drains — without it the process hangs and the orchestrator SIGKILLs it,
 * which loses in-flight work.
 * @param server - The server returned by `startServer`.
 * @returns Resolves once everything is closed.
 */
export async function gracefulShutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Promise.allSettled([closeDatabase(), closeRedis()])
}
```

```ts
// src/index.ts — entrypoint. Fails fast on a bad environment.
//
// `@/server` is imported DYNAMICALLY, and that is load-bearing. A static
// import is hoisted and evaluated before any statement in this file, and it
// reaches `database.service.ts`, which calls `getEnv()` at module scope. So
// with a static import the environment throws during import resolution —
// BEFORE the try/catch below can run — and the user gets an uncaught stack
// trace instead of the clean list. That is the exact defect this whole repo
// was rebuilt to remove, reintroduced one layer up. Verified both ways.
import { getEnv } from '@/configs/env.config'

try {
  getEnv()
} catch (error) {
  // One readable list, then exit. Not a stack trace from inside a dependency.
  console.error((error as Error).message)
  process.exit(1)
}

const { startServer, gracefulShutdown } = await import('@/server')
const server = startServer()

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // The backstop timer lives HERE, not inside gracefulShutdown:
    // `unicorn/no-process-exit` allows process.exit only at an entrypoint, and
    // keeping it out of the exported function leaves that function pure and
    // unit-testable — it can resolve without ever terminating the process.
    const forced = setTimeout(() => process.exit(1), 10_000)
    void gracefulShutdown(server).then(() => {
      clearTimeout(forced)
      process.exit(0)
    })
  })
}
```

- [ ] **Step 8: Test `server.ts` against an ephemeral port**

`server.ts` is deliberately not excluded from coverage, so it needs a test. Port 0 lets the OS pick a free port, which keeps the test safe to run in parallel and on CI.

```ts
// tests/integration/server.test.ts
import { describe, expect, it } from 'vitest'
import { gracefulShutdown, startServer } from '@/server'

describe('server lifecycle', () => {
  it('listens, then shuts down without leaving the socket open', async () => {
    // Port 0 passed as an argument, NOT via process.env — getEnv() memoises and
    // database.service already called it at import time, so an env assignment
    // here would be ignored and the server would bind the configured port.
    const server = startServer(0)
    await new Promise((resolve) => server.once('listening', resolve))
    expect(server.listening).toBe(true)

    await gracefulShutdown(server)
    expect(server.listening).toBe(false)
  })
})
```

Run: `pnpm test tests/integration/server.test.ts`
Expected: PASS. If it hangs, the drain order in `gracefulShutdown` is wrong — that is the bug this test exists to catch.

- [ ] **Step 9: Verify the whole thing runs and fails fast**

```bash
pnpm build && node dist/index.js &
sleep 2 && curl -s localhost:4040/health && curl -s localhost:4040/health/ready
kill %1

# and the fail-fast path
env -u DATABASE_URL pnpm exec tsx src/index.ts; echo "exit=$?"
```

Expected: the probes return JSON; the second command prints `Invalid environment:` naming `DATABASE_URL` and exits `1`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: split app construction, the server and the entrypoint

core's src/index.ts is 38k and builds the app, mounts routes, starts
workers, listens and shuts down in one file. createApp() has no side
effects so supertest can import it; server.ts owns the socket and the
drain order; index.ts fails fast on a bad environment.

/health is shallow on purpose — checking the database there turns a
transient blip into a restart loop. /health/ready is the deep one."
```

---

## Task 7: Commit hygiene — husky, commitlint, lint-staged

**Files:**

- Create: `.husky/pre-commit`, `.husky/pre-push`, `.husky/commit-msg`, `commitlint.config.js`
- Modify: `package.json`

**Interfaces:**

- Produces: a pre-commit hook that runs in seconds on changed files only, and a pre-push hook that runs the full sweep.

- [ ] **Step 1: Add the tooling**

```bash
pnpm add -D husky@^9.1.7 lint-staged@17.5.1 @commitlint/cli@21.2.2 \
  @commitlint/config-conventional@^21.2.0 @commitlint/cz-commitlint@^21.2.0 commitizen@^4.3.2
pnpm exec husky init
```

**Required, and easy to forget:** Task 1 set `"prepare": "husky || true"` because
husky was not yet a dependency and pnpm 12 re-runs a failed root lifecycle script
on every later `pnpm install`/`pnpm exec`, which would have left the shell
permanently red. Now that husky IS installed, change it back:

```json
"prepare": "husky"
```

Leaving the `|| true` in place would silently swallow real husky failures — a
hook that fails to install would look identical to one that installed fine.
Verify on a FRESH clone, not in place: pnpm 12 skips root lifecycle scripts on a
no-op install, so `rm -rf .husky/_ && pnpm install` in an already-installed repo
proves nothing. Clone the branch to a temp directory, run `pnpm install`, and
confirm `.husky/_` exists and a bad commit message is rejected there.

- [ ] **Step 2: Write the hooks**

```sh
# .husky/pre-commit
# Fast checks only — this hook looks at what you changed. The full sweep is
# in pre-push. If a step here grows past a few seconds, move it.
set -e

# Lockfile drift: under a second, and it catches the exact mistake that sends
# PRs to CI red, since CI installs with --frozen-lockfile and refuses.
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null

pnpm exec lint-staged

# Tests for what you touched AND everything importing it — vitest walks the
# module graph, so editing one utility pulls in its dependents.
pnpm exec vitest run --changed HEAD --passWithNoTests

# .env.example is generated. Regenerate it when the schema is staged, so the
# example can never drift from the schema it documents.
if git diff --cached --name-only | grep -q 'src/configs/env.config.ts'; then
  pnpm env:example
  git add .env.example
fi
```

```sh
# .husky/pre-push
set -e
pnpm lint
pnpm test:coverage
```

Note the hooks call `pnpm exec`, not `npx`. This repo's old hook ran `npx eslint`, which on a machine without `node_modules` silently downloads the newest ESLint and fails against a legacy config — observed on 2026-09-14.

```js
// commitlint.config.js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: { 'body-max-line-length': [0, 'always'] },
}
```

Add to `package.json`:

```json
"lint-staged": {
  "src/**/*.ts": ["eslint --fix", "prettier --write"],
  "**/*.{json,md}": ["prettier --write"]
},
"config": { "commitizen": { "path": "@commitlint/cz-commitlint" } }
```

- [ ] **Step 3: Verify the commit-msg hook rejects a bad message**

```bash
printf '.husky/commit-msg\npnpm exec commitlint --edit "$1"\n' > .husky/commit-msg
echo "x" > /tmp/probe.txt && git add -A
git commit -m "bad message with no type" || echo "rejected as expected"
```

Expected: rejected — `subject may not be empty` / `type may not be empty`.

- [ ] **Step 4: Commit with a valid message**

```bash
git commit -m "chore: add husky hooks, commitlint and lint-staged

Hooks call pnpm exec, not npx: the old hook ran npx eslint, which on a
machine without node_modules downloads the newest ESLint and fails
against the legacy config."
```

---

## Task 8: CI, Dockerfile and repository hygiene

**Files:**

- Create: `.github/workflows/ci.yml`, `.github/workflows/gitleaks.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `.gitleaks.toml`, `.pre-commit-config.yaml`, `Dockerfile`, `.dockerignore`, `.devcontainer/devcontainer.json`, `SECURITY.md`

**Interfaces:**

- Produces: a CI run that gates lint, types, tests, coverage, a secret scan, an audit and a domain-leak grep.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
    branches: [main, develop]
  workflow_dispatch:
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      # GitHub's `services:` blocks cannot mount a file, so the init.sql that
      # docker-compose uses to create the test role/database is unavailable
      # here. Set the credentials directly instead — they must match .env.test.
      postgres:
        image: postgres:18
        env: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: boilerplate_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd=pg_isready --health-interval=10s --health-timeout=5s --health-retries=5
      redis:
        image: redis:7.2-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd="redis-cli ping" --health-interval=10s --health-timeout=5s --health-retries=5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Lint and type-check
        run: pnpm lint
      - name: Test with coverage gate
        run: pnpm test:coverage
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/boilerplate_test
          REDIS_URL: redis://localhost:6379
      # The env block above must mirror committed .env.test. When they drift, a
      # test passes locally and fails in CI (or worse, the reverse) for reasons
      # that look nothing like the cause. This asserts every key in .env.test is
      # accounted for here.
      - name: Assert the CI env block mirrors .env.test
        run: |
          missing=0
          while IFS='=' read -r key _; do
            case "$key" in ''|\#*) continue ;; esac
            # Anchored to a YAML key, deliberately. A bare substring match is
            # satisfied by the key name appearing anywhere — including in a
            # comment — which makes the gate pass while the env block is
            # actually missing the variable.
            if ! grep -qE "^[[:space:]]+${key}:" .github/workflows/ci.yml; then
              echo "::error::$key is in .env.test but not in the CI env block"
              missing=1
            fi
          done < .env.test
          exit $missing
      - name: Build
        run: pnpm build
      - name: Audit production dependencies
        run: pnpm audit --prod
      # .env.example is generated from the Zod schema. Nothing stops someone
      # editing EnvSchema and forgetting to regenerate, and the drift is
      # invisible until a new contributor's first run fails on a variable the
      # example never mentioned. Regenerate and fail if the file moves.
      - name: Assert .env.example matches the schema
        run: |
          pnpm env:example
          git diff --exit-code .env.example \
            || { echo "::error::.env.example is stale — run 'pnpm env:example' and commit"; exit 1; }
      - name: Reject domain leakage
        # The boilerplate is derived from a product repo. This gate is why the
        # derivation can be trusted; without it, a scrub miss ships silently.
        run: |
          # The banned terms live in .github/domain-terms.txt, one
          # extended-regex per line — reviewable on its own, and it keeps this
          # step from having to spell the terms out and match itself.
          #
          # Most of the list is unambiguous product vocabulary and stays
          # unanchored. Three entries are ordinary English words on their own
          # — verified: "upgrading pnpm before you attempt lock acquisition
          # and check the async semantics" trips an unanchored list — so those
          # match only in compound form, and the one that is a substring of a
          # very common verb gets a word boundary instead.
          #
          # Scanning `git ls-files` rather than `grep -r --include=<ext>` is
          # deliberate: the extension allowlist exempted every tracked file
          # without a listed extension (.env.example, .env.test, init.sql, the
          # husky hooks, CODEOWNERS), and --exclude-dir=docs hid docs/
          # entirely. The index covers every committed file and nothing else.
          terms=.github/domain-terms.txt
          if [ ! -s "$terms" ] || grep -qE '^[[:space:]]*$' "$terms"; then
            echo "::error::$terms is missing, empty, or contains a blank line"
            exit 1
          fi
          hits=$(git ls-files -z | grep -zv '^\.github/domain-terms\.txt$' \
                   | xargs -0 grep -nHiEf "$terms" || true)
          if [ -n "$hits" ]; then
            echo "$hits"
            echo "::error::Domain reference found — scrub before merging."
            exit 1
          fi
```

- [ ] **Step 2: Verify the leak gate actually fires**

```bash
# Build the probe from the terms file itself, so this step never has to
# spell a banned term (and so it keeps working when the list changes).
term=$(head -1 .github/domain-terms.txt)
printf '// %s\n' "$term" > src/leak.utilities.ts
git add src/leak.utilities.ts   # the gate scans the index, so it must be staged
git ls-files -z | grep -zv '^\.github/domain-terms\.txt$' \
  | xargs -0 grep -nHiEf .github/domain-terms.txt && echo "gate would fail — correct"
git rm -q --cached src/leak.utilities.ts && rm src/leak.utilities.ts
```

Expected: the grep matches and prints the line, proving the gate is not a no-op.
Note the `git add`: `git ls-files` reads the index, so an unstaged probe file is
invisible to the gate and this verification would pass for the wrong reason.

- [ ] **Step 3: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7
# Multi-stage. node:24-alpine, not 22 — see Global Constraints.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
RUN adduser -D -u 10001 appuser
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# Cache mount keeps the store between builds without baking it into a layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
# Re-install without dev dependencies, so the runtime image carries neither
# the compiler nor drizzle-kit. Migrations run via dist/database/migrate.js.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

# The orchestrator owns liveness and readiness via /health and /health/ready.
# A Docker HEALTHCHECK would be a second, competing signal that disagrees with
# the first under load — one signal is better than two.
HEALTHCHECK NONE

USER appuser
EXPOSE 4040
CMD ["node", "dist/index.js"]
```

Verify the image boots and runs as a non-root user:

```bash
docker build -t boilerplate-api .
docker run --rm boilerplate-api node -e "console.log(process.getuid())"
```

Expected: prints `10001`, not `0`.

- [ ] **Step 4: Port the secret-scanning layer from `infra`**

```bash
cp "$REFERENCE_REPOS"/infra/.gitleaks.toml .
cp "$REFERENCE_REPOS"/infra/.pre-commit-config.yaml .
```

Then add the CI half, which the fleet does not have today — `infra`'s gitleaks runs only as a local pre-commit hook, which any developer can skip with `--no-verify`:

```yaml
# .github/workflows/gitleaks.yml
name: gitleaks
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```

- [ ] **Step 5: Write `dependabot.yml`, `CODEOWNERS`, `.devcontainer/`, `SECURITY.md`**

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: '/'
    schedule: { interval: weekly }
    open-pull-requests-limit: 10
    groups:
      # Grouped so a weekly bump is one reviewable PR per concern, not thirty.
      dev-tooling:
        patterns:
          [
            'eslint*',
            '@typescript-eslint/*',
            'typescript-eslint',
            'prettier*',
            'vitest',
            '@vitest/*',
          ]
      opentelemetry:
        patterns: ['@opentelemetry/*']
      types:
        patterns: ['@types/*']
  - package-ecosystem: github-actions
    directory: '/'
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: '/'
    schedule: { interval: weekly }
```

```
# .github/CODEOWNERS
* @mahaverick
/.github/ @mahaverick
/SECURITY.md @mahaverick
```

```json
// .devcontainer/devcontainer.json
{
  "name": "express-boilerplate",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:24",
  "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} },
  "postCreateCommand": "corepack enable && pnpm install",
  "forwardPorts": [4040, 5432, 6379, 8025],
  "customizations": {
    "vscode": {
      "extensions": ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
      "settings": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode"
      }
    }
  }
}
```

`SECURITY.md` is adapted from `infra`'s — that one is 38k and product-specific — down to a boilerplate-sized policy covering the decisions in spec §13: why no CSRF middleware is planned (Bearer tokens plus `SameSite` cookies), the password-hashing choice with argon2id noted as OWASP's current preference, and an explicit CSP. Each of those is an _intended_ choice for a later plan, and `SECURITY.md` must say so in those words — none of them ship in this one.

- [ ] **Step 6: Verify the full gate passes locally**

```bash
pnpm lint && pnpm test:coverage && pnpm build && pnpm audit --prod
echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "ci: gate lint, types, coverage, audit, secrets and domain leakage

The leak grep is what makes derive-and-strip trustworthy: the repo is
derived from a product codebase, so a scrub miss must fail the build
rather than ship.

Adds gitleaks as a CI workflow. The fleet has it only as a local
pre-commit hook today, which --no-verify skips."
```

---

## Task 9: The documentation set

**Files:**

- Create: `README.md` (rewrite), `ARCHITECTURE.md`, `STRUCTURE.md`, `DATABASE.md`, `CONTRIBUTING.md`, `MIGRATIONS.md`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/settings.json`, `.claude/skills/README.md`

**Interfaces:**

- Produces: the doc set every later plan appends to. `MIGRATIONS.md` is where each major bump's breaking changes are recorded, so the same upgrade can later be replayed on `core`.

- [ ] **Step 1: Rewrite `README.md` as a quickstart that actually works**

It must take a reader from clone to a served request in four commands, and every command must be run and verified before the task is committed:

```bash
pnpm install
docker compose up -d
pnpm bootstrap          # stubbed until plan B5; note that here
pnpm dev
```

- [ ] **Step 2: Write `MIGRATIONS.md` with the majors already taken**

**Also record the supply-chain bypasses, which are otherwise invisible.** pnpm 12
ships a minimum-release-age gate, and pinning "latest everything" trips it; pnpm
writes the bypasses into `pnpm-workspace.yaml`, a generated file nobody reads. As
of this plan the list is `zod@4.6.5` and `eslint-plugin-jsdoc@64.4.0` under
`minimumReleaseAgeExclude`, plus `esbuild` and `unrs-resolver` under
`allowBuilds` (both native-binary postinstalls; `unrs-resolver` is a transitive
dependency of `eslint-plugin-import-x` and is dev-only). Copy the current
contents of `pnpm-workspace.yaml` into `MIGRATIONS.md` with one line each on why,
and state the rule: every future addition to that file gets a line here too.

One row per major, each naming the breaking change and what had to change here. **TypeScript 6→7 — not adopted**: record the NO-GO, that `typescript-eslint@8.70.0` peers `>=4.8.4 <6.1.0`, that TS 7 itself passed `tsc`/`tsc-alias`/runtime in the spike, and that the unblock condition is a typescript-eslint release peering `^7`. Then Vitest 4→5, BullMQ 5→6, nodemailer 9→10, eslint-plugin-unicorn 71→74, pnpm 11→12, jsdom 29→30 (frontend), @tanstack/react-table 8→9 (frontend). Plus the two removals this plan makes: `express-async-handler` (Express 5 forwards rejections itself) and `drizzle-zod` (dropped upstream in `core`).

- [ ] **Step 3: Write `STRUCTURE.md` — where new code goes**

One line per directory, matching the `check-file` rules from Task 2 exactly, so the doc and the lint rule cannot disagree.

- [ ] **Step 4: Write `CLAUDE.md` — gotchas only**

Non-derivable context only, linking out to the others. Seed it with what this
plan established, each with its reason:

- **The pre-commit hook takes ~4.6s, and that is a deliberate trade.** About 70%
  is ESLint's type-aware cold start — building the TypeScript program. It is not
  removable without dropping type-aware linting, which is what catches floating
  and misused promises, the dominant real-bug class in async Express code. Before
  "optimising" this by deleting the lint step, read that trade: the alternative
  is committing broken code repeatedly and finding out at push. ESLint `--cache`
  does NOT help, because lint-staged only ever passes changed files, so a cache
  never hits.
- **Pre-commit deliberately excludes `tests/integration/**`.** Those need the
  Docker stack, and `vitest --changed HEAD` fans in: editing a widely-imported
  file pulls them in even when the stack is down, measured at 20s+ per hung
  probe and then a hard failure. A hook that fails when Docker is down gets
  disabled permanently and never comes back. Pre-push runs the full suite,
  where Docker being up is a fair expectation.
- `getEnv()` is lazy on purpose — a module-scope parse would throw during import
  resolution, which is the failure this repo was rebuilt to remove. It also
  memoises, so a test cannot change the environment by assigning `process.env`
  after any module has read it; pass values as arguments instead (see
  `startServer(port)`).
- `/health` is shallow on purpose; checking the database there turns a transient
  blip into a restart loop. `/health/ready` is the deep one.
- `express-async-handler` is deliberately absent — Express 5's router forwards
  rejected promises to `next(error)` itself.
- Hooks call `pnpm exec`, never `npx`. `npx eslint` on a machine without
  `node_modules` downloads the newest ESLint and fails against the local config.
- No module outside `env.config.ts` may read `process.env`; the lint rule
  enforces it.
- **No barrel files.** No `index.ts` re-export modules anywhere. Imports are
  direct (`@/services/foo.service`), which is what the reference repo does across
  2,997 imports. Barrels would also fail the `check-file` naming rules, and they
  hide real edges from `import-x/no-cycle`.
- `tsconfig.json` is the build config (`rootDir: ./src`) and covers `src/` only.
  `tsconfig.typecheck.json` is the wider project that lets eslint's type-aware
  rules and the test typecheck see `tests/`. Do not merge them — widening the
  build config yields TS6059 "not under rootDir" errors instead of type checking.

- [ ] **Step 5: Ship the agent tooling — WITHOUT an MCP server**

```bash
mkdir -p .claude/skills
```

Ship `AGENTS.md`, `CLAUDE.md` and `.claude/skills/README.md`, which explains the skill pattern and points at the `skills` repo's `TEMPLATE.md`. The `ss-*` styleseed skills are **not** copied — they encode a specific design system.

**Do NOT ship `.mcp.json`, and do NOT ship a `.claude/settings.json` that enables anything.** An earlier version of this plan copied `pulse`'s `.mcp.json`, which declares `npx shadcn@latest mcp`. That is wrong twice over:

1. **Supply-chain exposure.** `npx <pkg>@latest` resolves and executes the newest published version at launch — unpinned, outside the lockfile, with no review window. A compromise of that package or its npm account is code execution on every machine that opens the repo, and auto-enabling it in `.claude/settings.json` removes the one consent step that would catch it. In a boilerplate this is not one repo's exposure; it is every project derived from it.
2. **It is a frontend tool in a backend repo.** shadcn generates React components. Nothing in an Express API uses it. It was copied from a React app and labelled "generic" without anyone checking.

If a project wants an MCP server it adds one deliberately, with a **pinned** version. The frontend boilerplate may ship a pinned shadcn entry — that is its plan's call, not this one's. Record the reasoning in `SECURITY.md`, so the next person reaching for `npx <tool>@latest` in a config file sees why it was rejected here.

- [ ] **Step 6: Verify every command in the README**

Run each one in a clean clone. A quickstart that has not been executed end-to-end is a quickstart that does not work.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: add the full documentation set

MIGRATIONS.md records every major taken here so the same upgrade can be
replayed on core, which is behind on eight of them."
```

---

## Definition of done

- [ ] `pnpm install && pnpm lint && pnpm test:coverage && pnpm build` all exit 0 from a clean clone.
- [ ] `docker compose up -d && pnpm dev` serves `/health` and `/health/ready`.
- [ ] Unsetting any required variable makes `pnpm dev` print a named list and exit 1.
- [ ] Coverage is at or above 80% on all four metrics.
- [ ] An undocumented exported function fails `pnpm lint`.
- [ ] The domain-leak grep finds nothing.
- [ ] `src/` contains no file from the pre-port inventory.
- [ ] Task 0's verdict is committed, and if NO-GO the `typescript` pin and `MIGRATIONS.md` reflect it.

## Self-review notes

Checked against the spec on 2026-09-14.

**Spec coverage.** This plan implements §3 (target stack), §5.1 (env validation), §5.3 (compose), §5.5 (app split), §6 (conventions), §7 (test harness and coverage), §8 (hygiene), §12 (standards) and §14 (packaging fixes). Deferred with their owning plan: §4.1–4.4 → B2–B4; §4.5 platform services → B5; §5.2 OpenAPI and §5.4 bootstrap → B5 (both need routes and models to exist first); §13 MFA → B2, `audit_log` and pagination → B3.

**Known forward reference.** Task 9 Step 1 tells the reader to run `pnpm bootstrap`, which does not exist until B5. The step says so explicitly rather than leaving a broken command in the README.

**Type consistency.** `getEnv()`/`parseEnv()`/`Env` (Task 4) are consumed under those exact names in Tasks 5 and 6. `isDatabaseReachable()`/`isRedisReachable()`/`closeDatabase()`/`closeRedis()` (Task 5) are consumed under those names in Task 6. `createApp()`, `HttpError` and `errorHandler` (Task 6) are the names plans B2–B5 import.
