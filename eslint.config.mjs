/**
 * @file The flat ESLint config. A rule is disabled only for a stated semantic
 * reason, never for a count of existing violations; each block says why.
 */
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
import { commentStyleRule } from './scripts/comment-style.mjs'

/**
 * Test timing (tests/**): every real-time wait goes through tests/helpers/timing.ts.
 */
const BARE_SLEEP_MESSAGE =
  'No bare sleeps in tests. Wait on a condition with waitUntil (tests/helpers/timing.ts), use vi.useFakeTimers(), or, when nothing can be observed, settle(ms, reason).'
const timerPromiseImportBans = ['node:timers/promises', 'timers/promises'].map((name) => ({
  name,
  importNames: ['setTimeout'],
  message: BARE_SLEEP_MESSAGE,
}))

export default tseslint.config(
  {
    // tests/fixtures/** break the rules on purpose; lint-gates.test.ts lints them with `ignore: false`.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tests/fixtures/**',
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
        // The build tsconfig covers src/ only; this wider project lets type-aware rules see tests/.
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'check-file': checkFile, 'import-x': importX },
    /**
     * import-x settings. `import-x/extensions` must list .ts or no-cycle
     * silently never parses a TypeScript file. The resolver's own
     * `extensions` must too, or all four import-x rules silently skip every
     * .ts import. Its tsconfig path must be absolute: a relative one makes
     * aliased (`@/`) imports resolve to relative paths, which never equal the
     * absolute filename no-cycle compares against, so no-cycle never fires on them.
     */
    settings: {
      'import-x/extensions': ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'] },
      'import-x/resolver-next': [
        importX.createNodeResolver({
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.node'],
          tsconfig: { configFile: path.join(import.meta.dirname, 'tsconfig.json') },
        }),
      ],
    },
    rules: {
      // Collapses guard ladders such as canActorModifyTarget, and its output trips prefer-logical-operator-over-ternary.
      'unicorn/prefer-ternary': 'off',

      // env, db and repository are the canonical names (process.env, Drizzle's db, *.repository.ts files).
      'unicorn/name-replacements': [
        'error',
        { replacements: { env: false, db: false, repository: false } },
      ],

      // Express finds error handlers by arity, so an unused fourth parameter is load-bearing.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // No import order rule: the Prettier sort-imports plugin owns ordering.
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-duplicates': 'error',

      // Layer boundaries (see ARCHITECTURE.md); lint-gates.test.ts proves each zone fires.
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/controllers',
              from: ['./src/repositories', './src/services/database.service.ts'],
              message:
                'Controllers call services only, never a repository or the database client directly.',
            },
            {
              target: './src/controllers',
              from: './src/controllers',
              except: ['./base.controller.ts', './helpers.controller.ts'],
              message:
                'Controllers must not import other controllers (base.controller and helpers.controller excepted). Shared response shaping belongs in src/presenters/.',
            },
            {
              target: [
                './src/services',
                './src/repositories',
                './src/policies',
                './src/errors',
                './src/presenters',
              ],
              from: ['./src/controllers', './src/routes', './src/middlewares'],
              message:
                "The HTTP layer (controllers/routes/middlewares) must not be imported from below it. See ARCHITECTURE.md's layers table.",
            },
            {
              target: './src/repositories',
              from: './src/services',
              except: ['./database.service.ts'],
              message:
                'Repositories may only import services/database.service, for the db client and its types.',
            },
            {
              target: './src/policies',
              from: ['./src/repositories', './src/services', './src/database'],
              message: 'Policies are pure and boolean-returning: constants and types only.',
            },
            {
              target: './src/configs',
              from: './src/controllers',
              message: 'Configs must not import controllers.',
            },
          ],
        },
      ],

      // Descriptions are required and types are not: types live in TypeScript.
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

      // Configuration is read only through getEnv(), and logs go through the logger, except where exempted below.
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
          'src/presenters/**/*.ts': '*.presenter',
        },
      ],
      'check-file/folder-naming-convention': ['error', { 'src/**/': 'KEBAB_CASE' }],
    },
  },
  {
    // tracing.ts is a fixed-name entrypoint loaded by path with --import, not a module type.
    files: ['src/observability/**/*.ts'],
    rules: { 'check-file/filename-naming-convention': 'off' },
  },
  {
    // Security: the staff search reads every tenant, so only platform services import it; lint-gates.test.ts proves this fires.
    files: ['src/**/*.ts'],
    ignores: ['src/services/platform-*.service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/repositories/platform-tenant.repository', '**/platform-tenant.repository'],
              message:
                'Only services/platform-*.service.ts may import repositories/platform-tenant.repository.',
            },
          ],
        },
      ],
    },
  },
  /**
   * Every controller-scoped rule. Handlers are arrow fields, so routes can
   * mount them unbound; `unicorn/consistent-function-scoping` skips arrows
   * here because it would report each one as movable out of its class. Models may be imported for types only, which needs
   * `allowTypeImports` (no-restricted-paths has no such option).
   */
  {
    files: ['src/controllers/**/*.ts'],
    rules: {
      'unicorn/consistent-function-scoping': ['error', { checkArrowFunctions: false }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/database/models/*', '../database/models/*'],
              allowTypeImports: true,
              message:
                'Controllers may import database/models/** for TYPES only — use `import type`.',
            },
          ],
        },
      ],
    },
  },
  {
    // env.config.ts's whole job is parsing process.env.
    files: ['src/configs/env.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  /**
   * logger.service.ts reports a Slack failure with console.error, so it never
   * re-enters the logger. index.ts prints a failed boot check with
   * console.error and hands process.env to `assertEnvConsistent`, which checks
   * retired names the schema does not declare.
   */
  {
    files: ['src/services/logger.service.ts', 'src/index.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // tracing.ts loads before getEnv() and the logger, so it reads process.env and writes with console.
    files: ['src/observability/tracing.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  /**
   * Root configs and scripts sit outside the type-aware project, so they are
   * linted syntactically. Listed by name, not `*.config.ts`, so src/configs
   * stays type-checked.
   */
  {
    files: [
      '**/*.mjs',
      'scripts/**/*.d.mts',
      'vitest.config.ts',
      'vitest.unit.config.ts',
      'commitlint.config.js',
    ],
    extends: [tseslint.configs.disableTypeChecked],
  },
  /**
   * No test file lives under src/. The custom `errorMessage` is required:
   * without it, check-file validates the map's values as globs too.
   */
  {
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
      // The naming patterns above govern src/ only.
      'check-file/filename-naming-convention': 'off',
      // Test fixtures are known values, not secrets, e.g. a deliberately wrong JWT secret.
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
            ...timerPromiseImportBans,
          ],
        },
      ],
      // Timing: a bare sleep guesses a duration and fails under load (CLAUDE.md, "Test timing rules").
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']",
          message: BARE_SLEEP_MESSAGE,
        },
        { selector: "CallExpression[callee.name='sleep']", message: BARE_SLEEP_MESSAGE },
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: BARE_SLEEP_MESSAGE,
        },
      ],
    },
  },
  {
    // The one place that wraps supertest's default export. The timer ban still applies.
    files: ['tests/helpers/request.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: timerPromiseImportBans }] },
  },
  {
    // The one file that may wait on real time directly: it defines waitUntil and settle.
    files: ['tests/helpers/timing.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },
  {
    // Switched to 'error' at the stream gate; lanes run it with --rule until then.
    files: ['**/*.{ts,mts,js,mjs}'],
    plugins: { local: { rules: { 'comment-style': commentStyleRule } } },
    rules: { 'local/comment-style': 'off' },
  },
  {
    // .d.mts mirrors its .mjs exports; a second JSDoc copy would drift (same reason tests/** is off above).
    files: ['scripts/**/*.d.mts'],
    rules: { 'jsdoc/require-jsdoc': 'off' },
  },
  {
    // Lint tooling: its regexes are the tested contract, it is a CLI that prints to the terminal, and its tests import it as a module.
    files: [
      'scripts/history-patterns.mjs',
      'scripts/comment-style.mjs',
      'scripts/lint-docs.mjs',
      'scripts/lint-docs.d.mts',
    ],
    rules: {
      'sonarjs/regex-complexity': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'unicorn/no-null': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/no-exports-in-scripts': 'off',
      'unicorn/prefer-string-replace-all': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // Its test doubles share lint-docs.mjs's own interface names (exists, docRefProblems) and its own filename mirrors the module under test.
    files: ['tests/unit/lint-docs.test.ts'],
    rules: {
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-useless-concat': 'off',
    },
  },
  prettier
)
