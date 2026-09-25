// eslint.config.mjs — flat config.
//
// Ported from core/eslint.config.mjs with one deliberate difference: core
// disables ~25 unicorn rules, each justified by a count of existing
// violations ("304 — Express/Drizzle/zod call chains nest by design"). A
// greenfield repo has no such count, so only the disables with a stated
// semantic reason are carried over. The rest start ON.
import path from 'node:path'
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import checkFile from 'eslint-plugin-check-file'
import importX from 'eslint-plugin-import-x'
import jsdoc from 'eslint-plugin-jsdoc'
import promise from 'eslint-plugin-promise'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // tests/fixtures/** and src/lint-fixtures/** are deliberately-broken
    // fixtures (two committed import cycles — one relative, one through the
    // "@/" alias) that lint-gates.test.ts lints on purpose via
    // `ignore: false`. `pnpm lint` must not also trip over them.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tests/fixtures/**',
      'src/lint-fixtures/**',
      '.worktrees/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  sonarjs.configs.recommended,
  unicorn.configs.recommended,
  promise.configs['flat/recommended'],
  jsdoc.configs['flat/recommended-typescript'],
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // tsconfig.json covers src/ only — it is the build config. This wider
        // project is what lets type-aware rules see tests/ as well; without it
        // eslint fatals on every test file.
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'check-file': checkFile, 'import-x': importX },
    settings: {
      // eslint-plugin-import was dropped: its peer range excludes eslint 10
      // and the original config never wired it in. import-x is the
      // maintained flat-config fork; its own createNodeResolver (backed by
      // unrs-resolver, already a direct dependency) resolves tsconfig.json's
      // "@/*" paths, so no extra resolver package is needed.
      //
      // import-x/extensions is required specifically for no-cycle: its
      // traversal goes through ExportMap.for(), which checks a file's
      // extension against this setting (default .js/.mjs/.cjs only) before
      // ever attempting to parse it. Leave it unset and no-cycle silently
      // returns null for every .ts file and never fires. no-duplicates and
      // no-self-import do not use ExportMap and are unaffected by this
      // setting; no-useless-path-segments also skips it (with the options
      // used here — it's only read under the noUselessIndex option, unset
      // below). See the resolver-next comment below for the (different)
      // setting all four rules actually depend on.
      'import-x/extensions': ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'] },
      // createNodeResolver's own "extensions" option below is the separate
      // setting all four import-x rules in this file depend on: each calls
      // the shared resolve() helper to turn an extensionless "./foo" import
      // into a real file path, and createNodeResolver defaults to JS-only
      // extensions. Leave it unset and every one of these rules silently
      // no-ops on any .ts import it can't resolve, rather than erroring —
      // a second, distinct failure mode from the one above.
      //
      // tsconfig.configFile must be absolute. A cwd-relative path resolves
      // fine on its own, but no-cycle compares the resolved path of an
      // aliased import ("@/foo") against context.physicalFilename (always
      // absolute) with ===. A relative configFile makes the resolver hand
      // back relative paths for "@/*" imports specifically (plain relative
      // "./foo" imports come back absolute either way), so they never equal
      // filename and no-cycle silently never fires on aliased imports —
      // exactly the imports controllers/services/repositories will use.
      'import-x/resolver-next': [
        importX.createNodeResolver({
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.node'],
          tsconfig: { configFile: path.join(import.meta.dirname, 'tsconfig.json') },
        }),
      ],
    },
    rules: {
      // env.config.ts is the spec-mandated filename (src/configs/env.config.ts,
      // referenced throughout the plan, including the no-restricted-properties
      // exemption below). unicorn/name-replacements wants "environment.config.ts",
      // but "env" is not a lazy abbreviation here — it is the universal, canonical
      // spelling for this exact concept: .env, process.env, NODE_ENV, env.example.
      // Renaming to "environment" would diverge from all of those and from the
      // spec.
      //
      // `db` is carved out for the same reason, not as a blanket relaxation:
      // it is Drizzle's own name for its client, in Drizzle's own API and
      // documentation (`drizzle(...)` returns something every one of its
      // examples calls `db`), so `database.service.ts` exporting `db` matches
      // the ecosystem's spelling rather than abbreviating it. Every other
      // abbreviation the rule catches (req, res, err, ctx, ...) stays
      // enforced everywhere, including as identifiers — the plan's own code
      // samples deliberately spell those out (request, response, error), and
      // this repo should not drift from that.
      //
      // `repository` is carved out the same way: check-file's own
      // filename-naming-convention (below) requires every file under
      // src/repositories/ to end in ".repository.ts", and the B2 plan names
      // the exported classes `BaseRepository`/`UserRepository` exactly —
      // both directly contradict this rule's default preference for "repo".
      // Abbreviating only the identifiers and not the filenames (or vice
      // versa) would leave the class name and its file disagreeing with
      // each other.
      // OFF, and this is the one disable here that is about the rule being
      // WRONG for this codebase rather than about a naming clash.
      //
      // `prefer-ternary` wants a guard-clause ladder collapsed into a single
      // ternary. Its autofix turned `canActorModifyTarget`
      // (policies/tenant.policy.ts) — the three-branch owner/admin/member
      // authorization matrix — into one hundred-character nested ternary, and
      // did the same to `canActorGrantRole`, leaving `... ? ... : false`.
      // A permissions matrix is the last place to trade a readable ladder for
      // density.
      //
      // It also contradicts a rule shipped in the SAME major: the ternaries
      // its fixer produces immediately trip
      // `unicorn/prefer-logical-operator-over-ternary`, so running `--fix`
      // twice does not converge. Two rules from one plugin disagreeing about
      // the same lines is the plugin's problem, not this repo's.
      //
      // Its siblings `prefer-early-return` and `prefer-combined-guards` are
      // KEPT — those genuinely read better, and the sites they flagged were
      // fixed rather than exempted.
      'unicorn/prefer-ternary': 'off',

      'unicorn/name-replacements': [
        'error',
        { replacements: { env: false, db: false, repository: false } },
      ],

      // Express detects error handlers by arity — exactly four parameters —
      // so the unused fourth is load-bearing. The underscore prefix is the
      // signal that a parameter is deliberately unused; without this the only
      // alternatives are deleting a parameter Express needs, or an inline
      // disable in every handler.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // import/order is deliberately not enabled: @ianvs/prettier-plugin-sort-imports
      // already owns import ordering and the two rules would fight.
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-duplicates': 'error',

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

      // Secrets are read in exactly one place. Logs go through the
      // structured logger, not console.*, everywhere except the two files
      // exempted below.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from @/configs/env.config, not process.env. See spec §5.1.',
        },
        {
          object: 'console',
          property: 'error',
          message: 'Use logger from @/services/logger.service.',
        },
        {
          object: 'console',
          property: 'warn',
          message: 'Use logger from @/services/logger.service.',
        },
        {
          object: 'console',
          property: 'info',
          message: 'Use logger from @/services/logger.service.',
        },
        {
          object: 'console',
          property: 'log',
          message: 'Use logger from @/services/logger.service.',
        },
        {
          object: 'console',
          property: 'debug',
          message: 'Use logger from @/services/logger.service.',
        },
      ],

      'check-file/filename-naming-convention': [
        'error',
        {
          'src/controllers/**/*.ts': '*.controller',
          'src/repositories/**/*.ts': '*.repository',
          'src/services/**/*.ts': '*.service',
          'src/validators/**/*.ts': '*.validators',
          'src/routes/**/*.ts': '*.routes',
          'src/middlewares/**/*.ts': '*.middleware',
          'src/database/models/**/*.ts': '*.model',
          'src/utilities/**/*.ts': '*.utilities',
          'src/constants/**/*.ts': '*.constants',
          'src/configs/**/*.ts': '*.config',
          'src/templates/**/*.ts': '*.template',
          'src/jobs/**/*.ts': '*.job',
          'src/workers/**/*.ts': '*.worker',
          'src/policies/**/*.ts': '*.policy',
        },
      ],
      'check-file/folder-naming-convention': ['error', { 'src/**/': 'KEBAB_CASE' }],
    },
  },
  {
    // src/observability/ holds exactly one file, tracing.ts, which is not a
    // module TYPE the way controllers/services/repositories/etc. are — it is
    // a single fixed-name entrypoint loaded by path via `--import` (package.json's
    // "dev"/"start" scripts), so it can never carry one of the *.suffix
    // patterns every other governed directory above requires (there is no
    // "tracing.observability.ts" to rename it to). Turned off outright,
    // rather than adding a pattern that would fail on the file's own name —
    // same reasoning tests/**/*.ts gets below for the same rule.
    files: ['src/observability/**/*.ts'],
    rules: { 'check-file/filename-naming-convention': 'off' },
  },
  {
    // Rules specific to src/controllers/**. Keep every controller-scoped
    // rule in this one block rather than adding a second files: [...] entry
    // for the same directory.
    //
    // Handlers are arrow fields passed through `this.handle(...)` so routes
    // can mount them unbound; unicorn/consistent-function-scoping would
    // otherwise hoist each arrow out of its class.
    files: ['src/controllers/**/*.ts'],
    rules: { 'unicorn/consistent-function-scoping': ['error', { checkArrowFunctions: false }] },
  },
  {
    // env.config.ts is the one module allowed to read process.env — it is the
    // module whose whole job is to parse it.
    files: ['src/configs/env.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // logger.service.ts is the one module that writes through pino, and its
    // createSlackDestination's sendToSlack uses console.error for
    // failure logging to avoid re-entering the logger.
    // index.ts is the pre-boot error path where the logger is not yet
    // available (env validation failed before any service could initialize),
    // and it hands process.env to assertEnvConsistent, which needs the raw
    // names the schema no longer declares. Both rules (process.env and
    // console.*) are lifted; logger.service.ts reads no process.env.
    files: ['src/services/logger.service.ts', 'src/index.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // tracing.ts loads via `--import` before env.config.ts's own
    // `getEnv()` has ever run (before `src/index.ts` itself, in fact), so it
    // cannot go through `getEnv()` the way every other module must — it reads
    // `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`/`APP_ENV`/`OTEL_SERVICE_NAME`
    // directly. For the same load-order reason it cannot use the pino
    // logger (not loaded yet, and must not depend on the library it
    // instruments) — it uses `console.info`/`console.error` for its own
    // diagnostics instead. Both rules lifted, same shape as the exemption
    // above.
    files: ['src/observability/tracing.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Root-level flat configs (eslint.config.mjs, prettier.config.mjs,
    // vitest.config.ts, vitest.unit.config.ts, commitlint.config.js) sit outside
    // tsconfig.typecheck.json's "src/**/*" / "tests/**/*" include, so the
    // type-aware project cannot parse them. Lint them syntactically only.
    // Listed explicitly (not "*.config.ts") so this does not accidentally
    // widen to src/configs/**/*.config.ts, which must stay type-checked.
    files: ['**/*.mjs', 'vitest.config.ts', 'vitest.unit.config.ts', 'commitlint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Test placement. No test file lives under src/: tests go in tests/unit/
    // or tests/integration/, mirroring the src/ path of their subject
    // (src/services/queue.service.ts → tests/unit/services/queue.service.test.ts).
    // src/ holds shipped code only. A custom `errorMessage` is required:
    // without it, check-file validates the map's VALUES as glob patterns too
    // (see its README), and free text fails that.
    files: ['src/**/*.ts'],
    rules: {
      'check-file/filename-blocklist': [
        'error',
        {
          '**/*.{test,spec}.ts': 'tests/{unit,integration}/**/*.test.ts',
          '**/__tests__/**': 'tests/{unit,integration}/**/*.test.ts',
          'src/tests/**': 'tests/**',
        },
        {
          errorMessage:
            '`{{ target }}` is a test file under src/. Tests live in tests/unit/ or tests/integration/, mirroring the src/ path of the subject, e.g. src/services/queue.service.ts → tests/unit/services/queue.service.test.ts.',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      // `.test.`, never `.spec.`, and no `__tests__/` folders.
      'check-file/filename-blocklist': [
        'error',
        {
          '**/*.spec.ts': '*.test.ts',
          '**/__tests__/**': '*.test.ts',
        },
        {
          errorMessage:
            'This project uses `.test.ts` filenames under tests/unit/ or tests/integration/ — not `.spec.` and not a `__tests__/` folder.',
        },
      ],
      // The governed-directory patterns above are all scoped to src/**, so
      // none applies here; off for the same reason core turns it off for tests.
      'check-file/filename-naming-convention': 'off',
      // Fixture credentials in tests are not real secrets — they exist so
      // the test can assert against a known value, never to guard anything.
      // Both rules below are the same false-positive class:
      // hardcoded-secret-signatures is tripped by token.utilities.test.ts
      // signing a JWT with a deliberately-wrong secret to prove rejection.
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/hardcoded-secret-signatures': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'supertest',
              importNames: ['default', 'agent'],
              message:
                'Use `request` from tests/helpers/request: it binds 127.0.0.1 (see that file).',
            },
          ],
        },
      ],
    },
  },
  {
    // The one place that wraps supertest's default export.
    files: ['tests/helpers/request.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier
)
