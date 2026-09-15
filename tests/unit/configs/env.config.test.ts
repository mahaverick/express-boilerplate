import { describe, expect, it } from 'vitest'
import { getDatabaseUrl, getEnv, parseEnv } from '@/configs/env.config'

const valid = {
  NODE_ENV: 'test',
  APP_PORT: '4040',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
}

describe('parseEnv', () => {
  it('coerces APP_PORT from string to number', () => {
    expect(parseEnv(valid).APP_PORT).toBe(4040)
  })

  it('defaults APP_PORT when absent', () => {
    // Rest-sibling destructuring to build a source object missing this key;
    // the APP_PORT binding itself is intentionally unused.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { APP_PORT, ...rest } = valid
    expect(parseEnv(rest).APP_PORT).toBe(4040)
  })

  it('names every missing key in one message, not just the first', () => {
    // Same rest-sibling pattern, dropping two keys this time.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { DATABASE_URL, REDIS_URL, ...rest } = valid
    let message = ''
    try {
      parseEnv(rest)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
  })

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/)
  })

  it('rejects a malformed URL', () => {
    expect(() => parseEnv({ ...valid, APP_URL: 'not-a-url' })).toThrow(/APP_URL/)
  })

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(valid))).toBe(true)
  })

  it('treats an empty-string optional value as absent, not a malformed URL', () => {
    // Simulates `cp .env.example .env`: the generator leaves genuinely
    // optional keys either commented out or, if uncommented, as `KEY=`.
    // dotenv has no other way to express "unset" than an empty value.
    expect(() => parseEnv({ ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: '' })).not.toThrow()
    expect(
      parseEnv({ ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: '' }).OTEL_EXPORTER_OTLP_ENDPOINT
    ).toBeUndefined()
  })

  it('still reports a required field as missing, not as an empty-string format error', () => {
    let message = ''
    try {
      parseEnv({ ...valid, DATABASE_URL: '' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
  })
})

describe('getEnv', () => {
  // Vitest's global setup (tests/helpers/setup-global.ts) loads .env.test
  // into process.env before any test file runs, so this exercises the real
  // memoised parse of process.env rather than a hand-built source object.
  it('parses process.env and reports the test environment', () => {
    expect(getEnv().NODE_ENV).toBe('test')
  })

  it('memoises: repeated calls return the same object reference', () => {
    expect(getEnv()).toBe(getEnv())
  })
})

describe('getDatabaseUrl', () => {
  // Vitest's global setup loads .env.test, so DATABASE_URL is already
  // present in process.env here — this is what drizzle.config.ts relies on
  // when only DATABASE_URL (not the full schema) is exported.
  it('reads DATABASE_URL from process.env without requiring the rest of the schema', () => {
    expect(getDatabaseUrl()).toBe(process.env.DATABASE_URL)
  })

  it('throws, naming DATABASE_URL, when it is missing', () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      expect(() => getDatabaseUrl()).toThrow(/DATABASE_URL/)
    } finally {
      process.env.DATABASE_URL = original
    }
  })
})
