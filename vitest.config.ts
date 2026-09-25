import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// Extension included deliberately, unlike src/'s @/-aliased imports: this
// file is loaded by Vite's own config loader, not the bundled resolution
// pipeline used for src/tests — Vite warned "configLoader: 'native' ...
// import without a file extension ... planned to become the default in a
// future major version" when this was extensionless.
import { WORKER_COUNT } from './tests/helpers/worker-database.ts'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/helpers/setup-global.ts'],
    // Runs once, in the main process, before any worker starts — unlike
    // setupFiles above, which runs per test file inside every forked
    // worker. Migrating the database from setupFiles would mean up to
    // maxWorkers processes racing to apply the same migration concurrently.
    // See tests/helpers/global-setup.ts for the full reasoning.
    globalSetup: ['./tests/helpers/global-setup.ts'],
    alias: [
      { find: '@/tests', replacement: path.resolve(dirname, './tests') },
      { find: '@', replacement: path.resolve(dirname, './src') },
    ],
    pool: 'forks',
    // Pinned rather than left to default to (availableParallelism() - 1):
    // database.service.ts opens a real postgres pool (max: DB_POOL_MAX, 2 in .env.test)
    // at module scope in every forked worker that imports it, so the
    // connection ceiling is workers x pool.max. Left unpinned, that ceiling
    // tracks whichever machine happens to run the suite — a CI runner with
    // more cores than expected could push it past Postgres's default
    // max_connections (100) in a way that looks like a random, intermittent
    // failure rather than a sizing bug. 8 workers x DB_POOL_MAX 2 = 16,
    // comfortably under 100 regardless of host core count.
    //
    // `maxWorkers`, not `poolOptions.forks.maxForks`: this Vitest release
    // moved every `poolOptions` field to a top-level option (verified —
    // `poolOptions` now warns "removed ... All previous poolOptions are now
    // top-level options", and `maxWorkers?: number | string` is what the
    // installed package's own config types declare in its place).
    //
    // Sourced from tests/helpers/worker-database.ts's WORKER_COUNT, not a
    // second literal `8` kept in sync by comment: that file provisions
    // exactly WORKER_COUNT per-worker test databases in global setup, keyed
    // off vitest's own VITEST_POOL_ID ("value is between 1-maxWorkers"). If
    // this number and that one ever disagreed, a worker could be assigned a
    // pool id with no matching database — a connection error with nothing
    // in it to suggest a configuration mismatch caused it. One constant,
    // imported here, makes that impossible rather than merely commented
    // against.
    maxWorkers: WORKER_COUNT,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Without an explicit include, v8 only counts files some test happens
      // to import — an entire untested module (e.g. everything under
      // src/configs/**, which check-file forces to be named *.config.ts and
      // which '**/*.config.ts' used to exclude by construction) can ship
      // while the summary still reads 100%. Scoping to src/**/*.ts makes the
      // gate see every source file, tested or not.
      include: ['src/**/*.ts'],
      exclude: [
        'coverage/**',
        'dist/**',
        '**/*.d.ts',
        'tests/**',
        '**/*.test.ts',
        '**/migrations/**',
        '**/seeders/**',
        // Drizzle table/relation definitions and their InferSelectModel/
        // InferInsertModel type exports — schema metadata, not branching
        // logic. `pgTable(...)`'s column builders and `relations(...)`'s
        // callback bodies only ever execute once, at module-import time, to
        // build the schema drizzle-orm hands to the query builder; nothing
        // under tests/ calls them directly; the actual read/write behaviour
        // they describe is exercised through the repositories that query
        // through them instead (src/repositories/**, already covered).
        // Counting this directory dragged the whole-repo statement average
        // down to ~59% for a folder that has no meaningful branches to miss.
        'src/database/models/**',
        // Deliberately NOT '**/*.config.ts': root-level tool configs
        // (vitest.config.ts, drizzle.config.ts) already sit outside
        // src/**/*.ts and so are already excluded by `include` above.
        // Excluding it here used to also exempt every file under
        // src/configs/** (check-file forces that directory's filenames to
        // end in .config.ts), permanently hiding real, branch-heavy
        // validation code from the gate.
        //
        // The entrypoint only wires signals and calls process.exit; it is
        // exercised for real in Task 6 Step 7. server.ts is deliberately NOT
        // excluded — Task 6 tests it against an ephemeral port.
        'src/index.ts',
        // Same reasoning as src/index.ts above: this module's real branch
        // (OTEL_EXPORTER_OTLP_ENDPOINT set, building and starting a real
        // NodeSDK) is process bootstrap wiring loaded via `--import`, before
        // any test framework is attached — not meaningfully unit-testable.
        // tests/unit/observability/tracing.test.ts still exercises the
        // module (import succeeds, shutdownOtel() no-ops) in its default,
        // endpoint-unset state; only the "endpoint set" branch is excluded
        // here in spirit — this exclusion just covers the whole file, same
        // granularity as src/index.ts's.
        'src/observability/tracing.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
