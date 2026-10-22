/**
 * @file The Vite+ config: the Oxlint rules, the Oxfmt options and the Vitest
 * suite. The suite has two projects: `unit`, which the git hooks run with Docker down, and
 * `integration`, whose per-worker databases are created and migrated in
 * global setup.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vite-plus'
// With its extension: Vite's native config loader warns on an extensionless import.
import { WORKER_COUNT } from './tests/helpers/worker-database.ts'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The message for the test-only bans on bare sleeps; a real-time wait in a
 * test goes through `waitUntil` or `settle` in tests/helpers/timing.ts.
 */
const BARE_SLEEP_MESSAGE =
  'No bare sleeps in tests. Wait on a condition with waitUntil (tests/helpers/timing.ts), use vi.useFakeTimers(), or, when nothing can be observed, settle(ms, reason).'
const timerPromiseImportBans = ['node:timers/promises', 'timers/promises'].map((name) => ({
  name,
  importNames: ['setTimeout'],
  message: BARE_SLEEP_MESSAGE,
}))

/**
 * The cross-tenant platform repositories. Only services/platform-*.service.ts
 * may import them, since they read every tenant, user, email and onboarding
 * record; lint-gates.test.ts proves the ban fires.
 */
const platformRepositoryBan = {
  patterns: [
    {
      group: [
        '@/repositories/platform-tenant.repository',
        '**/platform-tenant.repository',
        '@/repositories/platform-stats.repository',
        '**/platform-stats.repository',
        '@/repositories/platform-user.repository',
        '**/platform-user.repository',
        '@/repositories/platform-email.repository',
        '**/platform-email.repository',
        '@/repositories/platform-onboarding.repository',
        '**/platform-onboarding.repository',
      ],
      message:
        'Only services/platform-*.service.ts may import the cross-tenant platform repositories.',
    },
  ],
}

/**
 * Configuration is read only through getEnv(), and logs go through the
 * logger, except in the files the overrides exempt.
 */
const configAndConsoleBans = [
  {
    object: 'process',
    property: 'env',
    message:
      'Read configuration from @/configs/env.config, not process.env. See ARCHITECTURE.md, "Configuration".',
  },
  ...['error', 'warn', 'info', 'log', 'debug'].map((property) => ({
    object: 'console',
    property,
    message: 'Use logger from @/services/logger.service.',
  })),
]

/**
 * Files outside the type-aware project, linted syntactically as
 * eslint.config.mjs's disableTypeChecked block does.
 */
const UNTYPED_FILES = ['**/*.mjs', 'scripts/**/*.d.mts', 'vite.config.ts', 'commitlint.config.js']

export default defineConfig({
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn', 'promise', 'jsdoc', 'import', 'node', 'vitest'],
    options: {
      typeAware: true,
      typeCheck: false,
      denyWarnings: true,
      reportUnusedDisableDirectives: 'error',
      // eslint-disable comments belong to the rules eslint.config.mjs still runs; Oxlint's own are oxlint-disable.
      respectEslintDisableDirectives: false,
    },
    categories: { correctness: 'error' },
    env: { builtin: true, es2026: true, node: true },
    // tests/fixtures/** break the rules on purpose; lint-gates.test.ts lints them with `ignore: false`.
    ignorePatterns: [
      'dist/**',
      'coverage/**',
      '.vitest/**',
      'node_modules/**',
      'tests/fixtures/**',
      '.worktrees/**',
      '.claude/**',
    ],
    /**
     * Every rule tests/fixtures/lint-inventory.json assigns to Oxlint, at
     * error, with origin/main's ESLint options; tests/unit/lint-inventory.test.ts
     * pins the set. The rules ESLint still runs are in eslint.config.mjs.
     */
    rules: {
      'eslint/array-callback-return': 'error',
      'eslint/block-scoped-var': 'error',
      'eslint/constructor-super': 'error',
      'eslint/default-case-last': 'error',
      'eslint/for-direction': 'error',
      'eslint/getter-return': ['error', { allowImplicit: false }],
      'eslint/logical-assignment-operators': ['error', 'always'],
      'eslint/no-array-constructor': 'error',
      'eslint/no-async-promise-executor': 'error',
      'eslint/no-case-declarations': 'error',
      'eslint/no-class-assign': 'error',
      'eslint/no-compare-neg-zero': 'error',
      'eslint/no-cond-assign': ['error', 'except-parens'],
      'eslint/no-const-assign': 'error',
      'eslint/no-constant-binary-expression': ['error', { checkRelationalComparisons: false }],
      'eslint/no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
      'eslint/no-control-regex': 'error',
      'eslint/no-debugger': 'error',
      'eslint/no-delete-var': 'error',
      'eslint/no-dupe-class-members': 'error',
      'eslint/no-dupe-else-if': 'error',
      'eslint/no-dupe-keys': 'error',
      'eslint/no-duplicate-case': 'error',
      'eslint/no-else-return': 'error',
      'eslint/no-empty': ['error', { allowEmptyCatch: false }],
      'eslint/no-empty-character-class': 'error',
      'eslint/no-empty-pattern': ['error', { allowObjectPatternsAsParameters: false }],
      'eslint/no-empty-static-block': 'error',
      'eslint/no-ex-assign': 'error',
      'eslint/no-extra-boolean-cast': ['error', {}],
      'eslint/no-fallthrough': [
        'error',
        { allowEmptyCase: false, reportUnusedFallthroughComment: false },
      ],
      'eslint/no-func-assign': 'error',
      'eslint/no-global-assign': ['error', { exceptions: [] }],
      'eslint/no-import-assign': 'error',
      'eslint/no-invalid-regexp': ['error', {}],
      'eslint/no-irregular-whitespace': [
        'error',
        {
          skipComments: false,
          skipJSXText: false,
          skipRegExps: false,
          skipStrings: true,
          skipTemplates: false,
        },
      ],
      'eslint/no-labels': 'error',
      'eslint/no-loop-func': 'error',
      'eslint/no-loss-of-precision': 'error',
      'eslint/no-misleading-character-class': ['error', { allowEscape: false }],
      'eslint/no-new': 'error',
      'eslint/no-new-native-nonconstructor': 'error',
      'eslint/no-new-wrappers': 'error',
      'eslint/no-nonoctal-decimal-escape': 'error',
      'eslint/no-obj-calls': 'error',
      'eslint/no-param-reassign': 'error',
      'eslint/no-prototype-builtins': 'error',
      'eslint/no-redeclare': ['error', { builtinGlobals: true }],
      'eslint/no-regex-spaces': 'error',
      'eslint/no-restricted-imports': ['error', platformRepositoryBan],
      'eslint/no-restricted-properties': ['error', ...configAndConsoleBans],
      'eslint/no-self-assign': ['error', { props: true }],
      'eslint/no-self-compare': 'error',
      'eslint/no-setter-return': 'error',
      'eslint/no-shadow-restricted-names': ['error', { reportGlobalThis: true }],
      'eslint/no-sparse-arrays': 'error',
      'eslint/no-this-before-super': 'error',
      'eslint/no-unassigned-vars': 'error',
      'eslint/no-undef': ['error', { typeof: false }],
      'eslint/no-unreachable': 'error',
      'eslint/no-unsafe-finally': 'error',
      'eslint/no-unsafe-negation': ['error', { enforceForOrderingRelations: false }],
      'eslint/no-unsafe-optional-chaining': ['error', { disallowArithmeticOperators: false }],
      'eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: false, allowTaggedTemplates: false, allowTernary: false },
      ],
      'eslint/no-unused-labels': 'error',
      'eslint/no-unused-private-class-members': 'error',
      'eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'eslint/no-useless-assignment': 'error',
      'eslint/no-useless-backreference': 'error',
      'eslint/no-useless-catch': 'error',
      'eslint/no-useless-concat': 'error',
      'eslint/no-useless-escape': ['error', { allowRegexCharacters: [] }],
      'eslint/no-useless-return': 'error',
      'eslint/no-var': 'error',
      // sonarjs/void-use allowed `void` on a promise, which is how fire-and-forget calls are marked.
      'eslint/no-void': ['error', { allowAsStatement: true }],
      'eslint/no-with': 'error',
      'eslint/operator-assignment': ['error', 'always'],
      'eslint/prefer-const': ['error', { destructuring: 'any', ignoreReadBeforeAssign: false }],
      'eslint/prefer-rest-params': 'error',
      'eslint/prefer-spread': 'error',
      'eslint/preserve-caught-error': ['error', { requireCatchParameter: false }],
      'eslint/require-yield': 'error',
      'eslint/use-isnan': ['error', { enforceForIndexOf: false, enforceForSwitchCase: true }],
      'eslint/valid-typeof': ['error', { requireStringLiterals: false }],
      'import/no-cycle': [
        'error',
        { ignoreExternal: true, allowUnsafeDynamicCyclicDependency: false, ignoreTypes: false },
      ],
      'import/no-duplicates': 'error',
      'import/no-named-default': 'error',
      'import/no-self-import': 'error',
      'jsdoc/check-access': 'error',
      'jsdoc/check-property-names': 'error',
      'jsdoc/check-tag-names': ['error', { typed: true }],
      'jsdoc/empty-tags': 'error',
      'jsdoc/implements-on-classes': 'error',
      'jsdoc/no-blank-blocks': ['error', { enableFixer: false }],
      'jsdoc/no-defaults': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/require-property': 'error',
      'jsdoc/require-property-description': 'error',
      'jsdoc/require-property-name': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-throws-type': 'error',
      'jsdoc/require-yields': 'error',
      'jsdoc/require-yields-type': 'error',
      'oxc/approx-constant': 'error',
      'oxc/bad-bitwise-operator': 'error',
      'oxc/bad-char-at-comparison': 'error',
      'oxc/bad-comparison-sequence': 'error',
      'oxc/branches-sharing-code': 'error',
      'oxc/double-comparisons': 'error',
      'oxc/erasing-op': 'error',
      'oxc/misrefactored-assign-op': 'error',
      'promise/always-return': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-callback-in-promise': 'error',
      'promise/no-multiple-resolved': 'error',
      'promise/no-nesting': 'error',
      'promise/no-new-statics': 'error',
      'promise/no-promise-in-callback': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/prefer-await-to-then': 'error',
      'promise/valid-params': 'error',
      'typescript/await-thenable': 'error',
      'typescript/ban-ts-comment': 'error',
      'typescript/no-array-delete': 'error',
      'typescript/no-base-to-string': 'error',
      'typescript/no-deprecated': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-duplicate-type-constituents': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-for-in-array': 'error',
      'typescript/no-implied-eval': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-redundant-type-constituents': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-boolean-literal-compare': 'error',
      'typescript/no-unnecessary-condition': 'error',
      'typescript/no-unnecessary-template-expression': 'error',
      'typescript/no-unnecessary-type-assertion': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unnecessary-type-conversion': 'error',
      'typescript/no-unsafe-argument': 'error',
      'typescript/no-unsafe-assignment': 'error',
      'typescript/no-unsafe-call': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-enum-comparison': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-unsafe-member-access': 'error',
      'typescript/no-unsafe-return': 'error',
      'typescript/no-unsafe-unary-minus': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/only-throw-error': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-for-of': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/prefer-promise-reject-errors': 'error',
      'typescript/prefer-regexp-exec': 'error',
      'typescript/require-array-sort-compare': 'error',
      'typescript/require-await': 'error',
      'typescript/restrict-plus-operands': 'error',
      'typescript/restrict-template-expressions': 'error',
      'typescript/triple-slash-reference': 'error',
      'unicorn/catch-error-name': ['error', { name: 'error', ignore: [] }],
      'unicorn/consistent-assert': 'error',
      'unicorn/consistent-date-clone': 'error',
      'unicorn/consistent-empty-array-spread': 'error',
      'unicorn/consistent-existence-index-check': 'error',
      'unicorn/consistent-function-scoping': ['error', { checkArrowFunctions: true }],
      'unicorn/consistent-template-literal-escape': 'error',
      'unicorn/error-message': 'error',
      'unicorn/escape-case': 'error',
      'unicorn/explicit-length-check': ['error', { 'non-zero': 'greater-than' }],
      'unicorn/explicit-timer-delay': ['error', 'always'],
      'unicorn/filename-case': 'error',
      'unicorn/import-style': ['error', {}],
      'unicorn/max-nested-calls': ['error', { max: 3 }],
      'unicorn/new-for-builtins': 'error',
      'unicorn/no-abusive-eslint-disable': 'error',
      'unicorn/no-accessor-recursion': 'error',
      'unicorn/no-anonymous-default-export': 'error',
      'unicorn/no-array-callback-reference': 'error',
      'unicorn/no-array-fill-with-reference-type': 'error',
      'unicorn/no-array-for-each': 'error',
      'unicorn/no-array-method-this-argument': 'error',
      'unicorn/no-array-reduce': ['error', { allowSimpleOperations: true }],
      'unicorn/no-array-reverse': ['error', { allowExpressionStatement: true }],
      'unicorn/no-array-sort': ['error', { allowExpressionStatement: true }],
      'unicorn/no-await-expression-member': 'error',
      'unicorn/no-await-in-promise-methods': 'error',
      'unicorn/no-confusing-array-with': 'error',
      'unicorn/no-console-spaces': 'error',
      'unicorn/no-document-cookie': 'error',
      'unicorn/no-empty-file': 'error',
      'unicorn/no-immediate-mutation': 'error',
      'unicorn/no-instanceof-builtins': [
        'error',
        { useErrorIsError: false, strategy: 'loose', include: [], exclude: [] },
      ],
      'unicorn/no-invalid-fetch-options': 'error',
      'unicorn/no-invalid-remove-event-listener': 'error',
      'unicorn/no-lonely-if': 'error',
      'unicorn/no-magic-array-flat-depth': 'error',
      'unicorn/no-negated-condition': 'error',
      'unicorn/no-negation-in-equality-check': 'error',
      'unicorn/no-nested-ternary': 'error',
      'unicorn/no-new-array': 'error',
      'unicorn/no-new-buffer': 'error',
      'unicorn/no-object-as-default-parameter': 'error',
      'unicorn/no-process-exit': 'error',
      'unicorn/no-single-promise-in-promise-methods': 'error',
      'unicorn/no-static-only-class': 'error',
      'unicorn/no-thenable': 'error',
      'unicorn/no-this-assignment': 'error',
      'unicorn/no-typeof-undefined': ['error', { checkGlobalVariables: false }],
      'unicorn/no-unnecessary-array-flat-depth': 'error',
      'unicorn/no-unnecessary-array-splice-count': 'error',
      'unicorn/no-unnecessary-await': 'error',
      'unicorn/no-unnecessary-slice-end': 'error',
      'unicorn/no-unreadable-array-destructuring': 'error',
      'unicorn/no-unreadable-iife': 'error',
      'unicorn/no-useless-collection-argument': 'error',
      'unicorn/no-useless-error-capture-stack-trace': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/no-useless-iterator-to-array': 'error',
      'unicorn/no-useless-length-check': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-switch-case': 'error',
      // unicorn skips arguments in TypeScript files; the JS-files override checks them.
      'unicorn/no-useless-undefined': [
        'error',
        { checkArguments: false, checkArrowFunctionBody: true },
      ],
      'unicorn/no-zero-fractions': 'error',
      'unicorn/numeric-separators-style': [
        'error',
        {
          onlyIfContainsSeparator: false,
          binary: { minimumDigits: 0, groupLength: 4 },
          octal: { minimumDigits: 0, groupLength: 4 },
          hexadecimal: { minimumDigits: 0, groupLength: 2 },
          number: { minimumDigits: 5, groupLength: 3 },
        },
      ],
      'unicorn/prefer-add-event-listener': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-at': ['error', { getLastElementFunctions: [], checkAllIndexAccess: false }],
      'unicorn/prefer-bigint-literals': 'error',
      'unicorn/prefer-blob-reading-methods': 'error',
      'unicorn/prefer-class-fields': 'error',
      'unicorn/prefer-classlist-toggle': 'error',
      'unicorn/prefer-code-point': 'error',
      'unicorn/prefer-date-now': 'error',
      'unicorn/prefer-default-parameters': 'error',
      'unicorn/prefer-dom-node-append': 'error',
      'unicorn/prefer-dom-node-remove': 'error',
      'unicorn/prefer-dom-node-text-content': 'error',
      'unicorn/prefer-event-target': 'error',
      'unicorn/prefer-export-from': ['error', { checkUsedVariables: true }],
      'unicorn/prefer-global-this': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-keyboard-event-key': 'error',
      'unicorn/prefer-logical-operator-over-ternary': 'error',
      'unicorn/prefer-math-min-max': 'error',
      'unicorn/prefer-math-trunc': 'error',
      'unicorn/prefer-modern-dom-apis': 'error',
      'unicorn/prefer-modern-math-apis': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/prefer-native-coercion-functions': 'error',
      'unicorn/prefer-negative-index': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-number-coercion': 'error',
      'unicorn/prefer-number-properties': ['error', { checkInfinity: false, checkNaN: false }],
      'unicorn/prefer-object-from-entries': ['error', { functions: [] }],
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/prefer-prototype-methods': 'error',
      'unicorn/prefer-query-selector': ['error', { allowWithVariables: false }],
      'unicorn/prefer-reflect-apply': 'error',
      'unicorn/prefer-regexp-test': 'error',
      'unicorn/prefer-response-static-json': 'error',
      'unicorn/prefer-set-has': 'error',
      'unicorn/prefer-set-size': 'error',
      'unicorn/prefer-single-call': ['error', { ignore: [] }],
      'unicorn/prefer-spread': 'error',
      'unicorn/prefer-string-raw': 'error',
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/prefer-string-trim-start-end': 'error',
      'unicorn/prefer-structured-clone': ['error', { functions: [] }],
      'unicorn/prefer-top-level-await': 'error',
      'unicorn/prefer-type-error': 'error',
      'unicorn/relative-url-style': ['error', 'never'],
      'unicorn/require-array-join-separator': 'error',
      'unicorn/require-module-attributes': 'error',
      'unicorn/require-module-specifiers': 'error',
      'unicorn/require-number-to-fixed-digits-argument': 'error',
      'unicorn/switch-case-braces': ['error', 'always'],
      'unicorn/switch-case-break-position': 'error',
      'unicorn/text-encoding-identifier-case': ['error', { withDash: false }],
      'unicorn/throw-new-error': 'error',
      // sonarjs/assertions-in-tests followed calls into the expect* helpers.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
      'vitest/hoisted-apis-on-top': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-interpolation-in-snapshots': 'error',
      // sonarjs/assertions-in-test-cases accepted assertions in hooks.
      'vitest/no-standalone-expect': [
        'error',
        { additionalTestBlockFunctions: ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'] },
      ],
      'vitest/prefer-each': 'error',
      'vitest/prefer-hooks-on-top': 'error',
      // Vitest's expect takes a message as its second argument.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/valid-title': 'error',
      /**
       * Adopted with correctness: in the category but never in origin/main, with
       * 0 hits. Listed so tests/unit/lint-inventory.test.ts pins them on.
       */
      'eslint/no-caller': 'error',
      'eslint/no-eval': 'error',
      'eslint/no-iterator': 'error',
      'eslint/no-useless-rename': 'error',
      'import/default': 'error',
      'import/namespace': 'error',
      'oxc/bad-array-method-on-arguments': 'error',
      'oxc/bad-match-all-arg': 'error',
      'oxc/bad-min-max-func': 'error',
      'oxc/bad-object-literal-comparison': 'error',
      'oxc/bad-replace-all-arg': 'error',
      'oxc/const-comparisons': 'error',
      'oxc/missing-throw': 'error',
      'oxc/number-arg-out-of-range': 'error',
      'oxc/only-used-in-recursion': 'error',
      'oxc/uninvoked-array-callback': 'error',
      'typescript/no-meaningless-void-operator': 'error',
      'typescript/no-unnecessary-parameter-property-assignment': 'error',
      'typescript/no-useless-default-assignment': 'error',
      'typescript/no-useless-empty-export': 'error',
      'vitest/prefer-snapshot-hint': 'error',
      'vitest/require-awaited-expect-poll': 'error',
      'vitest/require-local-test-context-for-concurrent-snapshots': 'error',
      'vitest/valid-describe-callback': 'error',
      'vitest/valid-expect-in-promise': 'error',
      'vitest/warn-todo': 'error',

      // Noise: 394 and 53 disable comments, no protection (the migration audit, flag 8).
      'unicorn/no-null': 'off',
      'typescript/unbound-method': 'off',
      // Oxfmt owns these, as eslint-config-prettier did.
      'unicorn/number-literal-case': 'off',
      'eslint/no-unexpected-multiline': 'off',
      // Off on origin/main: ESLint's kept jsdoc/no-types bans JSDoc types, so this would contradict it.
      'jsdoc/require-property-type': 'off',
      /**
       * In the correctness category but never in origin/main, so outside the
       * migration's parity contract; each fires on code ESLint accepted
       * (hits: 197, 29, 24, 7, 7).
       */
      'vitest/require-mock-type-parameters': 'off',
      'vitest/no-conditional-expect': 'off',
      'vitest/require-to-throw-message': 'off',
      'vitest/no-conditional-tests': 'off',
      'typescript/no-misused-spread': 'off',
    },
    overrides: [
      {
        // TypeScript reports these itself, as typescript-eslint's eslint-recommended override assumes.
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'eslint/constructor-super': 'off',
          'eslint/getter-return': 'off',
          'eslint/no-class-assign': 'off',
          'eslint/no-const-assign': 'off',
          'eslint/no-dupe-class-members': 'off',
          'eslint/no-dupe-keys': 'off',
          'eslint/no-func-assign': 'off',
          'eslint/no-import-assign': 'off',
          'eslint/no-new-native-nonconstructor': 'off',
          'eslint/no-obj-calls': 'off',
          'eslint/no-redeclare': 'off',
          'eslint/no-setter-return': 'off',
          'eslint/no-this-before-super': 'off',
          'eslint/no-undef': 'off',
          'eslint/no-unreachable': 'off',
          'eslint/no-unsafe-negation': 'off',
          'eslint/no-with': 'off',
        },
      },
      {
        // typescript-eslint's eslint-recommended override enabled these for TypeScript files only.
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        rules: {
          'eslint/no-var': 'off',
          'eslint/prefer-const': 'off',
          'eslint/prefer-rest-params': 'off',
          'eslint/prefer-spread': 'off',
          'unicorn/no-useless-undefined': [
            'error',
            { checkArguments: true, checkArrowFunctionBody: true },
          ],
        },
      },
      {
        files: UNTYPED_FILES,
        rules: {
          'typescript/await-thenable': 'off',
          'typescript/no-array-delete': 'off',
          'typescript/no-base-to-string': 'off',
          'typescript/no-deprecated': 'off',
          'typescript/no-duplicate-type-constituents': 'off',
          'typescript/no-floating-promises': 'off',
          'typescript/no-for-in-array': 'off',
          'typescript/no-implied-eval': 'off',
          'typescript/no-meaningless-void-operator': 'off',
          'typescript/no-misused-promises': 'off',
          'typescript/no-redundant-type-constituents': 'off',
          'typescript/no-unnecessary-boolean-literal-compare': 'off',
          'typescript/no-unnecessary-condition': 'off',
          'typescript/no-unnecessary-template-expression': 'off',
          'typescript/no-unnecessary-type-assertion': 'off',
          'typescript/no-unnecessary-type-conversion': 'off',
          'typescript/no-unsafe-argument': 'off',
          'typescript/no-unsafe-assignment': 'off',
          'typescript/no-unsafe-call': 'off',
          'typescript/no-unsafe-enum-comparison': 'off',
          'typescript/no-unsafe-member-access': 'off',
          'typescript/no-unsafe-return': 'off',
          'typescript/no-unsafe-unary-minus': 'off',
          'typescript/no-useless-default-assignment': 'off',
          'typescript/only-throw-error': 'off',
          'typescript/prefer-promise-reject-errors': 'off',
          'typescript/prefer-regexp-exec': 'off',
          'typescript/require-array-sort-compare': 'off',
          'typescript/require-await': 'off',
          'typescript/restrict-plus-operands': 'off',
          'typescript/restrict-template-expressions': 'off',
        },
      },
      {
        /**
         * Byte-identical with the react and apex copies, so it takes no
         * call-site change; its loop counts UTF-16 code units, which for-of
         * over a string would turn into code points.
         */
        files: ['src/services/errors/error-scrubber.service.ts'],
        rules: { 'typescript/prefer-for-of': 'off' },
      },
      {
        files: ['src/services/platform-*.service.ts'],
        rules: { 'eslint/no-restricted-imports': 'off' },
      },
      {
        // Controller handlers are arrow fields, so routes can mount them unbound.
        files: ['src/controllers/**/*.ts'],
        rules: { 'unicorn/consistent-function-scoping': ['error', { checkArrowFunctions: false }] },
      },
      {
        /**
         * env.config.ts parses process.env; logger.service.ts and index.ts
         * report with console.error so they never re-enter the logger;
         * tracing.ts loads before getEnv() and the logger.
         */
        files: [
          'src/configs/env.config.ts',
          'src/services/logger.service.ts',
          'src/index.ts',
          'src/observability/tracing.ts',
        ],
        rules: { 'eslint/no-restricted-properties': 'off' },
      },
      {
        // Lint tooling: a CLI that prints to the terminal, and modules tests import.
        files: [
          'scripts/history-patterns.mjs',
          'scripts/comment-style.mjs',
          'scripts/lint-docs.mjs',
          'scripts/lint-docs.d.mts',
          'scripts/vendor-passkey-aaguids.mjs',
          'scripts/vendor-passkey-aaguids.d.mts',
        ],
        rules: {
          'eslint/no-restricted-properties': 'off',
          'unicorn/prefer-string-replace-all': 'off',
        },
      },
      {
        // The pre-push service check: a CLI that loads .env.test into process.env and prints to the terminal.
        files: ['scripts/check-test-services.mjs'],
        rules: { 'eslint/no-restricted-properties': 'off' },
      },
      {
        files: ['tests/**/*.ts'],
        rules: {
          'eslint/no-restricted-properties': 'off',
          'eslint/no-restricted-imports': [
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
        },
      },
      {
        // The one place that wraps supertest's default export. The timer ban still applies.
        files: ['tests/helpers/request.ts'],
        rules: { 'eslint/no-restricted-imports': ['error', { paths: timerPromiseImportBans }] },
      },
      {
        // The one file that may wait on real time directly: it defines waitUntil and settle.
        files: ['tests/helpers/timing.ts'],
        rules: { 'eslint/no-restricted-imports': 'off' },
      },
      {
        // A filename is concatenated on purpose so lint:docs does not read it as a citation.
        files: ['tests/unit/lint-docs.test.ts'],
        rules: { 'eslint/no-useless-concat': 'off' },
      },
    ],
  },
  /**
   * What the pre-commit hook runs on staged files (`vp staged`). The
   * no-error-on-unmatched-pattern flags and ESLint's `--no-warn-ignored` let a
   * commit whose staged files are all ignored pass.
   */
  staged: {
    '{src,tests}/**/*.ts': [
      'vp check --fix --no-error-on-unmatched-pattern',
      'eslint --fix --max-warnings 0 --no-warn-ignored',
      'vp fmt --no-error-on-unmatched-pattern',
    ],
    '**/*.{json,jsonc,md}': ['vp fmt --no-error-on-unmatched-pattern'],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    printWidth: 100,
    trailingComma: 'es5',
    sortPackageJson: false,
    sortImports: {
      groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index'], 'unknown'],
      internalPattern: ['@/'],
      newlinesBetween: false,
    },
    ignorePatterns: [
      'dist',
      'coverage',
      'pnpm-lock.yaml',
      // Generated by drizzle-kit in its own layout; formatting meta/_journal.json and the SQL would drift against the next `drizzle-kit generate`.
      'src/database/migrations',
      // The local SDD workspace and worktrees: generated artefacts, git-ignored, never source.
      '.superpowers',
      '.worktrees',
      // Vitest reporter output (git-ignored).
      '.vitest',
      // Generated by release-please in its own layout; it would write it straight back.
      'CHANGELOG.md',
      // Vendored community AAGUID list (about 1 MB of icon data URIs); refresh steps are in src/constants/passkey.constants.ts.
      'src/data/passkey-aaguids.json',
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    alias: [
      { find: '@/tests', replacement: path.resolve(dirname, './tests') },
      { find: '@', replacement: path.resolve(dirname, './src') },
    ],
    pool: 'forks',
    /**
     * Pinned, not left to the host's core count: every worker opens a pool of
     * DB_POOL_MAX connections, so 8 workers x 2 stays well under Postgres's
     * default 100 on any machine. It is `WORKER_COUNT` because
     * worker-database.ts provisions exactly that many databases, keyed by
     * `VITEST_POOL_ID`; a mismatch would surface as a bare connection error.
     */
    maxWorkers: WORKER_COUNT,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      /**
       * Explicit, so the gate counts every source file, including modules no
       * test imports.
       */
      include: ['src/**/*.ts'],
      /**
       * No `*.config.ts` glob: that would also exempt every file under
       * src/configs. Models are schema metadata run once at import and
       * exercised through the repositories. index.ts (signal wiring) and
       * tracing.ts (bootstrap loaded with `--import`) are not meaningfully
       * unit-testable; server.ts is not excluded.
       */
      exclude: [
        'coverage/**',
        'dist/**',
        '**/*.d.ts',
        'tests/**',
        '**/*.test.ts',
        '**/migrations/**',
        'src/database/models/**',
        'src/index.ts',
        'src/observability/tracing.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          /**
           * Everything but tests/integration/**, with no globalSetup and no
           * setup-rate-limits.ts: both reach Postgres or Redis, and the git
           * hooks run this project with Docker down. setup-global.ts loads
           * the test env and the worker's database and Redis prefix.
           */
          exclude: [...configDefaults.exclude, 'tests/integration/**'],
          setupFiles: ['./tests/helpers/setup-global.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          /**
           * setup-global.ts loads the test env and the worker's database and
           * Redis prefix; setup-rate-limits.ts, after it, clears this worker's
           * rate-limit counters before each file.
           */
          setupFiles: ['./tests/helpers/setup-global.ts', './tests/helpers/setup-rate-limits.ts'],
          /**
           * Runs once in the main process before any worker starts: it creates
           * and migrates every worker's own database and clears leftover
           * rate-limit counters from Redis. `setupFiles` runs once per test
           * file in every worker, so the migrator would run again for each
           * file.
           */
          globalSetup: ['./tests/helpers/global-setup.ts'],
        },
      },
    ],
  },
})
