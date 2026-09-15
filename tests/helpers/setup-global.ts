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
import { loadTestEnv } from './env'

loadTestEnv()
