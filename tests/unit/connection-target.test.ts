/**
 * @file docker-compose.yml deliberately moves Postgres/Redis off their
 * default host ports (5433/6380), so the suite cannot silently talk to a
 * developer's own native instance instead of the compose stack; that would
 * go unnoticed for Redis in particular, since any Redis answers PING. This
 * reads docker-compose.yml and .env.test off disk and asserts they agree on
 * a non-default port, rather than asserting on `getEnv()` at runtime: CI's
 * `services:` publish the container-default ports, so a runtime assertion
 * against the live environment is red on CI by construction.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The text of a file at the repository root.
 */
const read = (file: string): string => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')

const compose = read('docker-compose.yml')
const envTest = read('.env.test')

/**
 * The host-side port docker-compose.yml publishes for the compose service `service`.
 *
 * It reads the named service's own block rather than grepping the whole file for a port
 * number: a bare search for "5433" would be satisfied by the header comment that explains the
 * choice, so the assertion would pass even if the `ports:` mapping itself had been reverted.
 *
 * It parses line by line rather than with one multiline regex: the obvious
 * `/^\s*ports:.*?['"](\d+):(\d+)['"]/m` is flagged by sonarjs/super-linear-regex as
 * backtracking-prone (it puts two lazy quantifiers next to each other). The same rule rules out
 * matching the `ports:` mapping line itself
 * (`['[<bind-address>:]<host>:<container>', ...]`) with a `(\d+):(\d+)` pattern, so it splits
 * on `:` and takes the segment before the always-last container port, whether or not a bind
 * address prefixes it.
 */
const composeHostPort = (service: string): string => {
  const lines = compose.split(/\r?\n/)
  const start = lines.indexOf(`  ${service}:`)
  expect(start, `docker-compose.yml declares a "${service}" service`).toBeGreaterThan(-1)

  // The block runs until the next key at the same two-space indent.
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}\S/.test(line))
  const block = end === -1 ? rest : rest.slice(0, end)

  const portsLine = block.find((line) => line.trimStart().startsWith('ports:'))
  expect(portsLine, `the "${service}" service block declares a ports: mapping`).toBeDefined()
  const firstMapping = (portsLine ?? '').split(/['"]/, 3)[1] ?? ''
  const segments = firstMapping.split(':')
  const host = segments.at(-2) ?? ''
  expect(host, `the "${service}" ports: mapping reads host:container`).toMatch(/^\d+$/)
  return host
}

/**
 * The port that the URL in .env.test's `key` (such as DATABASE_URL) points at.
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

    // Both halves matter: agreement alone permits reverting to the default, and a non-default compose port alone permits dialling a developer's own instance.
    expect(published).not.toBe(target.theDefault)
    expect(published).toBe(target.nonDefault)
    expect(envTestPort(target.key)).toBe(published)
  })

  it('points the suite at Mailpit by IP literal, so a send never resolves a hostname', () => {
    const line = envTest.split(/\r?\n/).find((candidate) => candidate.startsWith('SMTP_HOST='))
    expect(line, '.env.test declares SMTP_HOST').toBeDefined()
    expect(net.isIP((line ?? '').slice('SMTP_HOST='.length)), 'SMTP_HOST is an IPv4 literal').toBe(
      4
    )
  })
})
