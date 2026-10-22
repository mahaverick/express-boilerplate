/**
 * @file The flat ESLint config for the rules Oxlint can't run yet; each one's
 * reason is in docs/lint-deferred.md. It is untyped: no rule here needs type
 * information. The rules are listed by name, then path-scoped overrides; a
 * comment above an override gives the reason it differs.
 */
import path from 'node:path'
import checkFile from 'eslint-plugin-check-file'
import importX from 'eslint-plugin-import-x'
import jsdoc from 'eslint-plugin-jsdoc'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import tseslint from 'typescript-eslint'
import { commentStyleRule } from './scripts/comment-style.mjs'

/**
 * The message for the test-only bans on bare sleeps; a real-time wait in a
 * test goes through `waitUntil` or `settle` in tests/helpers/timing.ts.
 */
const BARE_SLEEP_MESSAGE =
  'No bare sleeps in tests. Wait on a condition with waitUntil (tests/helpers/timing.ts), use vi.useFakeTimers(), or, when nothing can be observed, settle(ms, reason).'
/**
 * The message for the raw-SQL ban in src/.
 */
const RAW_SQL_MESSAGE =
  "Raw SQL is limited to src/database/models and three listed files. Use drizzle's sql template, or add the file to eslint.config.mjs with a reason."
/** The raw-SQL selectors match drizzle's `sql` by name, so an alias would slip past them. */
const SQL_ALIAS_MESSAGE =
  "Import drizzle's sql as `sql`, without an alias, so the raw SQL check can see it."

/**
 * Every named function, method and class; inline callbacks and constructors
 * are exempt by construction.
 */
const NAMED_FUNCTIONS = [
  'FunctionDeclaration',
  'TSDeclareFunction',
  'ClassDeclaration',
  'MethodDefinition:not([kind="constructor"]):not([value.body=null])',
  'TSAbstractMethodDefinition',
  'VariableDeclarator > ArrowFunctionExpression',
  'VariableDeclarator > FunctionExpression',
  'PropertyDefinition > ArrowFunctionExpression',
]
/**
 * Named functions plus interfaces, type aliases and exported consts.
 */
const JSDOC_CONTEXTS = [
  ...NAMED_FUNCTIONS,
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
]

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
  // The typescript-eslint parser and plugin with no rules and no type information.
  tseslint.configs.base,
  {
    plugins: {
      'check-file': checkFile,
      'import-x': importX,
      jsdoc,
      sonarjs,
      unicorn,
    },
    /**
     * import-x settings. The resolver's `extensions` must list .ts, or
     * no-restricted-paths skips every .ts import and no zone fires. Its
     * tsconfig path must be absolute, so aliased (`@/`) imports resolve.
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
      // Security rules with no Oxlint port.
      'sonarjs/code-eval': 'error',
      'sonarjs/content-length': 'error',
      'sonarjs/content-security-policy': 'error',
      'sonarjs/cookie-no-httponly': 'error',
      'sonarjs/cors': 'error',
      'sonarjs/csrf': 'error',
      'sonarjs/encryption-secure-mode': 'error',
      'sonarjs/file-permissions': 'error',
      'sonarjs/hardcoded-secret-signatures': 'error',
      'sonarjs/hashing': 'error',
      'sonarjs/insecure-cookie': 'error',
      'sonarjs/insecure-jwt-token': 'error',
      'sonarjs/no-clear-text-protocols': 'error',
      'sonarjs/no-hardcoded-ip': 'error',
      'sonarjs/no-hardcoded-passwords': 'error',
      'sonarjs/no-hardcoded-secrets': 'error',
      'sonarjs/no-mime-sniff': 'error',
      'sonarjs/no-os-command-from-path': 'error',
      'sonarjs/no-referrer-policy': 'error',
      'sonarjs/no-weak-cipher': 'error',
      'sonarjs/no-weak-keys': 'error',
      'sonarjs/production-debug': 'error',
      'sonarjs/pseudo-random': 'error',
      'sonarjs/publicly-writable-directories': 'error',
      'sonarjs/session-regeneration': 'error',
      'sonarjs/strict-transport-security': 'error',
      'sonarjs/super-linear-regex': 'error',
      'sonarjs/unverified-certificate': 'error',
      'sonarjs/unverified-hostname': 'error',
      'sonarjs/weak-ssl': 'error',
      'sonarjs/x-powered-by': 'error',

      // env, db and repository are the canonical names (process.env, Drizzle's db, *.repository.ts files); params and def are allowed only for the list contract's exported names (ListParams, listParamsSchema, SortDef), locals still spell parameters.
      'unicorn/name-replacements': [
        'error',
        { replacements: { env: false, db: false, repository: false, params: false, def: false } },
      ],
      'unicorn/consistent-boolean-name': 'error',
      'unicorn/no-async-promise-finally': 'error',
      'unicorn/no-loop-iterable-mutation': 'error',
      'unicorn/no-unsafe-property-key': 'error',
      'unicorn/no-unused-builtin-method-return': 'error',

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

      'jsdoc/check-alignment': 'error',
      // A returns tag on a function that returns nothing is a false claim.
      'jsdoc/require-returns-check': 'error',

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
    // The scrubber is byte-identical with the react and apex copies, whose ESLint has no sonarjs, so it cannot carry sonarjs disable comments; its regexes scan at most SCAN_MAX characters.
    files: ['src/services/errors/error-scrubber.service.ts'],
    rules: { 'sonarjs/super-linear-regex': 'off' },
  },
  {
    // tracing.ts is a fixed-name entrypoint loaded by path with --import, not a module type.
    files: ['src/observability/**/*.ts'],
    rules: { 'check-file/filename-naming-convention': 'off' },
  },
  /**
   * Controllers may import models for types only, which needs
   * `allowTypeImports` (no-restricted-paths has no such option).
   */
  {
    files: ['src/controllers/**/*.ts'],
    rules: {
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
  /**
   * Security: raw SQL bypasses drizzle's parameter binding, so in src/ it is
   * limited to the models and three files, each listed with its reason.
   * Tests are out of scope: their setup and migrations need raw SQL.
   */
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/database/models/**',
      // Splices fixed column names into the shared keyIn and isoText fragments, plus one constant tenant predicate.
      'src/repositories/platform-onboarding.repository.ts',
      // Emits the keyset seek operator (> or <) and the tuple separators, chosen in code from the sort direction.
      'src/utilities/list-page.utilities.ts',
      // Splices the status-rank CASE arms, built from the EMAIL_STATUS_RANK constant.
      'src/repositories/email-message.repository.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        // sql.raw called or taken as a value, and orm.sql.raw off a namespace import.
        {
          selector:
            "MemberExpression[property.name='raw']:matches([object.name='sql'], [object.property.name='sql'])",
          message: RAW_SQL_MESSAGE,
        },
        // sql['raw'] or any other computed key, which the name match above can't read.
        { selector: "MemberExpression[object.name='sql'][computed=true]", message: RAW_SQL_MESSAGE },
        {
          selector:
            "VariableDeclarator[init.name='sql'] > ObjectPattern > Property:matches([key.name='raw'], [key.value='raw'], [computed=true])",
          message: RAW_SQL_MESSAGE,
        },
        {
          selector:
            "ImportDeclaration[source.value='drizzle-orm'] > ImportSpecifier[imported.name='sql'][local.name!='sql']",
          message: SQL_ALIAS_MESSAGE,
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='unsafe']",
          message: RAW_SQL_MESSAGE,
        },
        // A plain string, untagged template or concatenation as a query; drizzle's sql`…` is a TaggedTemplateExpression.
        {
          selector:
            "CallExpression[callee.property.name='execute'][arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression)$/]",
          message: RAW_SQL_MESSAGE,
        },
      ],
    },
  },
  /**
   * No test file lives under src/. The custom `errorMessage` replaces the
   * default one, which would print the map's glob values as its suggestion.
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
      'sonarjs/hardcoded-secret-signatures': 'off',
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
    // The one file that may wait on real time directly: it defines waitUntil and settle.
    files: ['tests/helpers/timing.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Comment style is enforced; see CLAUDE.md.
    files: ['**/*.{ts,mts,js,mjs}'],
    plugins: { local: { rules: { 'comment-style': commentStyleRule } } },
    rules: { 'local/comment-style': 'error' },
  },
  {
    // Lint tooling: its regexes are the tested contract, lint-docs.mjs is a CLI that runs git by name, and its names mirror the files it checks.
    files: [
      'scripts/history-patterns.mjs',
      'scripts/comment-style.mjs',
      'scripts/lint-docs.mjs',
      'scripts/lint-docs.d.mts',
      'scripts/vendor-passkey-aaguids.mjs',
      'scripts/vendor-passkey-aaguids.d.mts',
    ],
    rules: {
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-boolean-name': 'off',
    },
  },
  {
    // Its filename mirrors lint-docs.mjs and it imports docRefProblems from it, and one test double is named exists.
    files: ['tests/unit/lint-docs.test.ts'],
    rules: {
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-boolean-name': 'off',
    },
  },
  {
    // Every named function, method and class carries a JSDoc purpose line; tags only where they add what types cannot.
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: false,
          require: { FunctionDeclaration: false },
          contexts: JSDOC_CONTEXTS,
          checkConstructors: false,
          // lint-staged runs eslint --fix, and this fixer inserts blank stubs.
          enableFixer: false,
        },
      ],
      'jsdoc/require-description': ['error', { contexts: JSDOC_CONTEXTS }],
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/no-types': 'error',
    },
  },
  {
    // .d.mts mirrors its .mjs exports; a second JSDoc copy would drift.
    files: ['scripts/**/*.d.mts'],
    rules: { 'jsdoc/require-jsdoc': 'off' },
  }
)
