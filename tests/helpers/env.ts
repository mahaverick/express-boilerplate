// tests/helpers/env.ts
//
// Shared by tests/helpers/setup-global.ts (a `setupFiles` hook — runs once
// per test file, inside every forked worker) and tests/helpers/global-setup.ts
// (a vitest `globalSetup` hook — runs exactly once, before any worker
// starts). Both need the identical precedence (real process env >
// .env.test.local > .env.test) applied before any module reads
// process.env, so the loading logic lives here once rather than twice.
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
    if (!match?.[1] || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
}

/**
 * Load `.env.test.local` then `.env.test` into `process.env`, without
 * overwriting a variable that is already set.
 */
export function loadTestEnv(): void {
  load('.env.test.local')
  load('.env.test')
}
