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
  // Split on \r?\n, not just '\n': a CRLF file's "lines" would otherwise
  // each end in a trailing \r that survives into the value.
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    // A lazy value group with a trailing `\s*$` handles trailing
    // whitespace in the pattern itself. sonarjs/super-linear-regex flags the
    // adjacent `\s*=\s*`/`\s*$` quantifiers as backtracking-prone in the
    // abstract, but `line` here is one line of a local, committed/git-ignored
    // .env file (bounded length, never attacker-controlled), so there is no
    // catastrophic-backtracking exposure to guard against.
    // eslint-disable-next-line sonarjs/super-linear-regex
    const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match?.[1]) continue
    if (process.env[match[1]] !== undefined) continue
    process.env[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
}

load('.env.test.local')
load('.env.test')
