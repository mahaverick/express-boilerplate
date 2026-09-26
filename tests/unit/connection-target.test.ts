// tests/unit/connection-target.test.ts
//
// docker-compose.yml deliberately moves Postgres/Redis off their default
// host ports (5433/6380) so the suite cannot silently talk to a developer's
// own native Postgres/Redis instead of the compose stack — see that file's
// header comment for the full reasoning. The failure mode is silent for
// Redis specifically (any Redis answers PING), so a reversion would not
// fail loudly the way the Postgres side would.
//
// WHAT THIS GUARDS, AND WHY IT IS NOT A RUNTIME CHECK. An earlier version
// asserted `getEnv().DATABASE_URL`'s port at runtime. That is the wrong
// invariant: CI's `services:` publish the container-default ports, so CI
// runs against 5432/6379 and real process env wins over
// .env.test (see tests/helpers/setup-global.ts) — the assertion failed in
// CI with `expected '6379' to be '6380'` while passing locally, i.e. it was
// guaranteed to be red on the first pull request.
//
// The property actually worth protecting belongs to committed files, not to
// whatever environment happens to be running the suite: docker-compose.yml
// and .env.test must agree, and must agree on a NON-default port. So this
// reads both files off disk and compares them. It is environment-independent
// by construction, which is why it lives under tests/unit/ and never opens a
// socket.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')

const compose = read('docker-compose.yml')
const envTest = read('.env.test')

/**
 * The host-side port docker-compose.yml publishes for one service.
 *
 * Scoped to the named service's own block rather than grepping the whole
 * file for a port number: a bare search for "5433" would be satisfied by the
 * header comment that explains the choice, so the assertion would pass even
 * if the `ports:` mapping itself had been reverted.
 *
 * Parsed line-by-line rather than with one multiline regex — the obvious
 * `/^\s*ports:.*?['"](\d+):(\d+)['"]/m` puts two lazy quantifiers next to
 * each other, which sonarjs/super-linear-regex flags as backtracking-prone.
 * @param service - The compose service name, e.g. "postgres".
 * @returns The published host port, as a string.
 */
const composeHostPort = (service: string): string => {
  const lines = compose.split(/\r?\n/)
  const start = lines.indexOf(`  ${service}:`)
  expect(start, `docker-compose.yml declares a "${service}" service`).toBeGreaterThan(-1)

  // The block runs until the next key at the same two-space indent.
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}\S/.test(line))
  const block = end === -1 ? rest : rest.slice(0, end)

  // ports: ['[<bind-address>:]<host>:<container>', ...] — the host side is
  // the one a developer's own service can collide with. Split rather than
  // match: any `(\d+):(\d+)` pattern trips sonarjs/super-linear-regex, and
  // there is no reason to run a backtracking-capable matcher over a string
  // this shaped.
  const portsLine = block.find((line) => line.trimStart().startsWith('ports:'))
  expect(portsLine, `the "${service}" service block declares a ports: mapping`).toBeDefined()
  const firstMapping = (portsLine ?? '').split(/['"]/, 3)[1] ?? ''
  // The container port is always last; the host port is the segment right
  // before it, whether or not a bind address prefixes the mapping.
  const segments = firstMapping.split(':')
  const host = segments.at(-2) ?? ''
  expect(host, `the "${service}" ports: mapping reads host:container`).toMatch(/^\d+$/)
  return host
}

/**
 * The port .env.test's URL for `key` points at.
 * @param key - The variable name, e.g. "DATABASE_URL".
 * @returns The port component of that URL, as a string.
 */
const envTestPort = (key: string): string => {
  const line = envTest.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`))
  expect(line, `.env.test declares ${key}`).toBeDefined()
  return new URL((line ?? '').slice(key.length + 1)).port
}

describe('local connection target', () => {
  it.each([
    { service: 'postgres', key: 'DATABASE_URL', nonDefault: '5433', theDefault: '5432' },
    { service: 'redis', key: 'REDIS_URL', nonDefault: '6380', theDefault: '6379' },
  ])('$service: compose and .env.test agree on a non-default host port', (target) => {
    const published = composeHostPort(target.service)

    // Both halves matter. Agreement alone would be satisfied by moving both
    // back to the default; a non-default compose port alone would be
    // satisfied while the suite still dialled the developer's own instance.
    expect(published).not.toBe(target.theDefault)
    expect(published).toBe(target.nonDefault)
    expect(envTestPort(target.key)).toBe(published)
  })
})
