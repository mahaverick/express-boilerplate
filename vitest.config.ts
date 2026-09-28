/**
 * @file The base Vitest config: the full suite, with per-worker databases
 * created and migrated in global setup. vitest.unit.config.ts derives the
 * hooks' unit-only config from it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// With its extension: Vite's native config loader warns on an extensionless import.
import { WORKER_COUNT } from './tests/helpers/worker-database.ts'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/helpers/setup-global.ts'],
    /**
     * Runs once in the main process before any worker starts, unlike
     * `setupFiles`, so parallel workers never race to apply the same migration.
     */
    globalSetup: ['./tests/helpers/global-setup.ts'],
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
        '**/seeders/**',
        'src/database/models/**',
        'src/index.ts',
        'src/observability/tracing.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
