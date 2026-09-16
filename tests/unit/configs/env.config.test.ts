import { describe, expect, it } from 'vitest'
import { getDatabaseUrl, getEnv, parseEnv, trustProxySetting } from '@/configs/env.config'

const valid = {
  NODE_ENV: 'test',
  APP_PORT: '4040',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
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

  it('defaults ACCESS_TOKEN_TTL to 15m and REFRESH_TOKEN_TTL to 30d when absent', () => {
    const parsed = parseEnv(valid)
    expect(parsed.ACCESS_TOKEN_TTL).toBe('15m')
    expect(parsed.REFRESH_TOKEN_TTL).toBe('30d')
  })

  it('accepts a custom, ms()-parseable TTL for either token', () => {
    const parsed = parseEnv({ ...valid, ACCESS_TOKEN_TTL: '1h', REFRESH_TOKEN_TTL: '7d' })
    expect(parsed.ACCESS_TOKEN_TTL).toBe('1h')
    expect(parsed.REFRESH_TOKEN_TTL).toBe('7d')
  })

  // This is the exact defect the whole rebuild was justified by: the old
  // codebase called `ms(process.env.REFRESH_TOKEN_EXPIRY)` directly, and an
  // unparseable (here: unset) value made `ms()` itself throw at
  // module-import time — a failure that named a third-party library instead
  // of the missing environment variable, and took down an unrelated test
  // suite before any test body ran. Pinning both halves of that property:
  // the failure is named, and it never originates from inside `ms`.
  it('rejects a malformed ACCESS_TOKEN_TTL with a validation error naming the field, not a throw from inside ms', () => {
    let message = ''
    let didThrowFromMs = false
    try {
      parseEnv({ ...valid, ACCESS_TOKEN_TTL: 'not-a-duration' })
    } catch (error) {
      message = (error as Error).message
      // ms()'s own thrown message, verbatim from its source: "val is not a
      // non-empty string or a valid number". If this ever appears here, the
      // refinement stopped catching ms() and let it throw straight through.
      didThrowFromMs = message.includes('val is not a non-empty string')
    }
    expect(message).toContain('ACCESS_TOKEN_TTL')
    expect(didThrowFromMs).toBe(false)
  })

  it('rejects a malformed REFRESH_TOKEN_TTL the same way', () => {
    expect(() => parseEnv({ ...valid, REFRESH_TOKEN_TTL: 'not-a-duration' })).toThrow(
      /REFRESH_TOKEN_TTL/
    )
  })

  it('defaults EMAIL_VERIFICATION_TTL to 24h', () => {
    expect(parseEnv(valid).EMAIL_VERIFICATION_TTL).toBe('24h')
  })

  it('rejects an EMAIL_VERIFICATION_TTL that ms() cannot parse', () => {
    expect(() => parseEnv({ ...valid, EMAIL_VERIFICATION_TTL: 'soon' })).toThrow(
      /EMAIL_VERIFICATION_TTL/
    )
  })

  it('rejects an unparseable env var by name alongside every other problem, not alone', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { DATABASE_URL, ...rest } = valid
    let message = ''
    try {
      parseEnv({ ...rest, ACCESS_TOKEN_TTL: 'not-a-duration' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('ACCESS_TOKEN_TTL')
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

describe('SMTP configuration', () => {
  it('defaults SMTP_HOST/SMTP_PORT to Mailpit’s local address when absent', () => {
    const parsed = parseEnv(valid)
    expect(parsed.SMTP_HOST).toBe('localhost')
    expect(parsed.SMTP_PORT).toBe(1025)
  })

  it('coerces SMTP_PORT from a string to a number', () => {
    expect(parseEnv({ ...valid, SMTP_PORT: '2525' }).SMTP_PORT).toBe(2525)
  })

  it('leaves SMTP_USER/SMTP_PASS undefined when absent — Mailpit needs no credentials', () => {
    const parsed = parseEnv(valid)
    expect(parsed.SMTP_USER).toBeUndefined()
    expect(parsed.SMTP_PASS).toBeUndefined()
  })

  it('accepts SMTP_USER/SMTP_PASS when a real provider needs them', () => {
    const parsed = parseEnv({ ...valid, SMTP_USER: 'apikey', SMTP_PASS: 'secret' })
    expect(parsed.SMTP_USER).toBe('apikey')
    expect(parsed.SMTP_PASS).toBe('secret')
  })

  it('defaults MAIL_FROM to a working local address', () => {
    expect(parseEnv(valid).MAIL_FROM).toBe('no-reply@example.com')
  })

  it('rejects a malformed MAIL_FROM', () => {
    expect(() => parseEnv({ ...valid, MAIL_FROM: 'not-an-address' })).toThrow(/MAIL_FROM/)
  })

  // Fix round 2 (task-2-review.md, finding 2): these bound a TIMING oracle
  // (Ruling G reopened through latency, not status), not merely a resource
  // leak — the defaults must stay bounded to tens of seconds, far below
  // nodemailer's own multi-minute defaults. Not single-digit seconds: this
  // project's own shared Mailpit measured at ~8.3s to send its greeting
  // (env.config.ts's own comment on SMTP_GREETING_TIMEOUT has the
  // measurement), so 15s is the real floor, not an arbitrary round number.
  it('defaults SMTP_CONNECTION_TIMEOUT/SMTP_GREETING_TIMEOUT/SMTP_SOCKET_TIMEOUT to bounded values, far below nodemailer', () => {
    const parsed = parseEnv(valid)
    expect(parsed.SMTP_CONNECTION_TIMEOUT).toBe(10_000)
    expect(parsed.SMTP_GREETING_TIMEOUT).toBe(15_000)
    expect(parsed.SMTP_SOCKET_TIMEOUT).toBe(20_000)
  })

  it('coerces the SMTP timeout variables from strings to numbers', () => {
    const parsed = parseEnv({
      ...valid,
      SMTP_CONNECTION_TIMEOUT: '1000',
      SMTP_GREETING_TIMEOUT: '2000',
      SMTP_SOCKET_TIMEOUT: '3000',
    })
    expect(parsed.SMTP_CONNECTION_TIMEOUT).toBe(1000)
    expect(parsed.SMTP_GREETING_TIMEOUT).toBe(2000)
    expect(parsed.SMTP_SOCKET_TIMEOUT).toBe(3000)
  })
})

describe('TRUST_PROXY', () => {
  it('defaults to "false" — trusting no proxy until an operator says otherwise', () => {
    // The default has to fail towards OVER-limiting (every client sharing
    // one bucket behind an unconfigured proxy) rather than towards no limit
    // at all (a spoofable X-Forwarded-For). See env.config.ts's comment.
    expect(parseEnv(valid).TRUST_PROXY).toBe('false')
  })

  it('refuses the literal "true", naming what to set instead', () => {
    // `trust proxy: true` believes every hop, so any client that can reach
    // the app can write its own X-Forwarded-For, get a fresh rate-limit
    // bucket per request, and walk straight through the login limiter.
    expect(() => parseEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
    expect(() => parseEnv({ ...valid, TRUST_PROXY: 'TRUE' })).toThrow(/TRUST_PROXY/)
  })

  it('accepts a hop count and an address list', () => {
    expect(parseEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1')
    expect(parseEnv({ ...valid, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback')
  })
})

describe('WORKER_ENABLED', () => {
  // The one regression this field exists to prevent: z.coerce.boolean()
  // coerces via JavaScript's own `Boolean(value)`, and `Boolean("false")` is
  // `true` — a `.env` file with `WORKER_ENABLED=false` would silently START
  // the worker. z.stringbool() (Zod 4) parses the string's actual content
  // instead, so this must resolve to the real boolean `false`, not the
  // string `"false"` and not `true`.
  it('parses WORKER_ENABLED=false as boolean false', () => {
    const env = parseEnv({ ...valid, WORKER_ENABLED: 'false' })
    expect(env.WORKER_ENABLED).toBe(false)
  })

  it('parses WORKER_ENABLED=true as boolean true', () => {
    const env = parseEnv({ ...valid, WORKER_ENABLED: 'true' })
    expect(env.WORKER_ENABLED).toBe(true)
  })

  it('defaults WORKER_ENABLED to true when unset', () => {
    const env = parseEnv(valid)
    expect(env.WORKER_ENABLED).toBe(true)
  })
})

describe('QUEUE_PREFIX', () => {
  it('defaults to "bull" when unset', () => {
    expect(parseEnv(valid).QUEUE_PREFIX).toBe('bull')
  })

  it('accepts a custom prefix — tests override this per vitest worker', () => {
    expect(parseEnv({ ...valid, QUEUE_PREFIX: 'bull:test-w3' }).QUEUE_PREFIX).toBe('bull:test-w3')
  })

  it('rejects an empty QUEUE_PREFIX', () => {
    expect(() => parseEnv({ ...valid, QUEUE_PREFIX: '' })).not.toThrow()
    // An empty string is dropped as "absent" (same treatment as every other
    // optional/defaulted field — see the "empty-string optional value"
    // test above), so it falls back to the default rather than failing
    // min(1) directly. Confirms the two rules AGREE rather than fighting.
    expect(parseEnv({ ...valid, QUEUE_PREFIX: '' }).QUEUE_PREFIX).toBe('bull')
  })
})

describe('trustProxySetting', () => {
  it('maps "false" to the boolean Express understands, not the string', () => {
    // A non-empty string is truthy, and Express reads a string as an address
    // list — so passing "false" through unconverted would mean "trust the
    // proxy at the address named `false`", which proxy-addr rejects at boot.
    expect(trustProxySetting('false')).toBe(false)
    expect(trustProxySetting('  FALSE  ')).toBe(false)
  })

  it('maps a whole number to a hop count', () => {
    expect(trustProxySetting('1')).toBe(1)
    expect(trustProxySetting('2')).toBe(2)
  })

  it('passes anything else through as an address list for Express to parse', () => {
    expect(trustProxySetting('loopback')).toBe('loopback')
    expect(trustProxySetting('10.0.0.0/8, 172.16.0.0/12')).toBe('10.0.0.0/8, 172.16.0.0/12')
  })
})
