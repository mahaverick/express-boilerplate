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
    // Pinned rather than left to default to (availableParallelism() - 1):
    // database.service.ts opens a real postgres pool (max: 2 in test mode)
    // at module scope in every forked worker that imports it, so the
    // connection ceiling is workers x pool.max. Left unpinned, that ceiling
    // tracks whichever machine happens to run the suite — a CI runner with
    // more cores than expected could push it past Postgres's default
    // max_connections (100) in a way that looks like a random, intermittent
    // failure rather than a sizing bug. 8 workers x 2 connections = 16,
    // comfortably under 100 regardless of host core count.
    //
    // `maxWorkers`, not `poolOptions.forks.maxForks`: this Vitest release
    // moved every `poolOptions` field to a top-level option (verified —
    // `poolOptions` now warns "removed ... All previous poolOptions are now
    // top-level options", and `maxWorkers?: number | string` is what the
    // installed package's own config types declare in its place).
    maxWorkers: 8,
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
        // A deliberately-circular fixture pair, not shippable source — see
        // src/lint-fixtures/cycle-a.ts. Excluded from the build too
        // (tsconfig.json), so counting it here would permanently drag the
        // gate down for code that never runs.
        'src/lint-fixtures/**',
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
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
