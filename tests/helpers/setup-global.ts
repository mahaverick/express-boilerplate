// tests/helpers/setup-global.ts
//
// WHY THIS EXISTS. Precedence is: real process env > .env.test.local
// (git-ignored, per-developer) > .env.test (committed, mirrors the CI env
// block). core learned this the hard way: loading the developer's own .env
// under test let 74 of 98 local keys leak into the suite, including live
// credentials, and made tests pass locally that failed in CI. A new test
// variable must be added to BOTH .env.test and .github/workflows/ci.yml.
//
// The loading logic itself lives in ./env — shared with
// tests/helpers/global-setup.ts, which needs the identical precedence
// applied before it can run migrations.
//
// useWorkerDatabase() then points DATABASE_URL at THIS worker's own
// dedicated test database (see ./worker-database for why) — before
// anything in this test file's own module graph (database.service.ts, via
// getEnv()) ever reads it.
import { loadTestEnv } from './env'
import { workerRedisKeyPrefix } from './redis-prefix'
import { useWorkerDatabase } from './worker-database'

loadTestEnv()
useWorkerDatabase()

// Per-worker Redis namespace — same mechanism as per-worker DATABASE_URL.
// Without it, a Worker in pool 1 would process pool 2's jobs and write
// email_logs into the wrong database, and rate-limit counters would be shared.
process.env.REDIS_KEY_PREFIX = workerRedisKeyPrefix(process.env.VITEST_POOL_ID ?? '0')
