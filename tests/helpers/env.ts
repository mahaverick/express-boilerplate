/**
 * @file Loads `.env.test.local` then `.env.test`, without overwriting an
 * already-set variable. Shared by `tests/helpers/setup-global.ts` and
 * `tests/helpers/global-setup.ts`, which both need this same precedence
 * (real process env > `.env.test.local` > `.env.test`) applied before any
 * module reads `process.env`.
 */
import fs from 'node:fs'
import path from 'node:path'

const load = (file: string): void => {
  const full = path.resolve(process.cwd(), file)
  if (!fs.existsSync(full)) return
  // Split on \r?\n: a CRLF file's lines would otherwise keep a trailing \r in the value.
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    // eslint-disable-next-line sonarjs/super-linear-regex -- line is one bounded line of a local, non-attacker-controlled .env file; no catastrophic-backtracking risk
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
