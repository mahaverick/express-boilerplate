/**
 * @file scrubText against the shared vectors (tests/fixtures/error-scrub-vectors.json),
 * which the frontends copy byte for byte, plus the properties no single
 * vector shows: idempotence, the length cap and the bounded scan.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_VALUE_MAX } from '@/constants/error-tracking.constants'
import { scrubText } from '@/services/errors/error-scrubber.service'

interface ScrubVector {
  rule: string
  input: string
  expected: string
}

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/error-scrub-vectors.json')
const vectors = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ScrubVector[]

const HARMLESS = [
  "Unexpected token '<'",
  "Cannot read properties of undefined (reading 'token')",
  'tokenizer: bad state',
  'passwordless flow disabled',
  'Basic validation failed',
  'https://app.example.com/assets/index-Bx9k2.js',
  'https://app.example.com/assets/session-panel-3f9a.js',
  'PlatformUserService.deactivate',
  'Foo.#privateMethod',
  'at SessionProvider (/src/states/session.tsx)',
  'mailto:support',
  'Invariant failed: route /tenants/$slug not found',
  'https://react.dev/errors/31',
  'Basic Plan upgrade required',
  'Basic settings',
  'basic validation failed',
  'BASIC settings',
  'value too long for type character varying(255)',
]

describe('scrubText vectors', () => {
  it.each(vectors.map((vector) => [vector.rule, vector.input, vector.expected]))(
    '%s: %s',
    (_rule, input, expected) => {
      expect(scrubText(input)).toBe(expected)
    }
  )

  it('covers every rule', () => {
    expect(new Set(vectors.map((vector) => vector.rule))).toEqual(
      new Set([
        'postgres',
        'query',
        'jwt',
        'bearer',
        'posthog-key',
        'email',
        'userinfo',
        'fragment',
        'kv',
        'basic',
        'pg-input',
        'json-snippet',
        'secret',
        'path',
        'cap',
      ])
    )
  })

  it('gives the same text when applied twice', () => {
    for (const { input } of vectors) {
      const once = scrubText(input)
      expect(scrubText(once)).toBe(once)
    }
  })
})

describe('scrubText', () => {
  it('cuts a long text to the cap, marker included', () => {
    const scrubbed = scrubText('word '.repeat(400))
    expect(scrubbed).toHaveLength(ERROR_VALUE_MAX)
    expect(scrubbed.endsWith('…[truncated]')).toBe(true)
  })

  it('keeps a text of exactly the cap whole', () => {
    const text = 'a b '.repeat(ERROR_VALUE_MAX / 4)
    expect(scrubText(text)).toBe(text)
  })

  it('never keeps half of a secret cut at the scan limit', () => {
    // The long run shrinks to [secret], pulling the hex that straddles the 4096th character into view.
    const text = `${'A'.repeat(3600)} ${'x '.repeat(240)}${'ab'.repeat(20)} tail`
    expect(text.indexOf('abab')).toBeLessThan(4 * ERROR_VALUE_MAX)
    expect(text.lastIndexOf('abab')).toBeGreaterThan(4 * ERROR_VALUE_MAX)
    const scrubbed = scrubText(text)
    expect(scrubbed.startsWith('[secret] x x')).toBe(true)
    expect(scrubbed).not.toContain('abab')
    expect(scrubbed.endsWith('…[truncated]')).toBe(true)
  })

  it('keeps harmless strings unchanged', () => {
    for (const text of HARMLESS) {
      expect(scrubText(text)).toBe(text)
    }
  })

  it('returns quickly on a long run with no @', () => {
    const started = performance.now()
    scrubText('a'.repeat(1_000_000))
    // Proves the scan cap bounds a megabyte input; the cap is SCAN_MAX (4 x ERROR_VALUE_MAX), which costs a few ms, so 1 s is far above it.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('scans a whitespace-rich input of every pathological shape in bounded time', () => {
    const shapes = [
      `Key (${'a'.repeat(60)})=(${'(x'.repeat(60)}`,
      `invalid input syntax for type ${'a '.repeat(30)}: "${'"x'.repeat(60)}`,
      `${', "x'.repeat(60)} is not valid`,
      `ftp://${'a'.repeat(120)}`,
      `/${'a/'.repeat(60)}?${'q'.repeat(60)}`,
      `https://h/${'a'.repeat(100)}#${'f'.repeat(60)}`,
      `Basic ${'A'.repeat(120)}`,
      `${'token'.repeat(24)} ${'password = '.repeat(12)}`,
      `${'a.'.repeat(60)}@${'b-'.repeat(60)}`,
      `${'a'.repeat(60)}%40${'b.'.repeat(60)}`,
    ]
    const text = `${shapes.join(' ')} `.repeat(4).slice(0, 4 * ERROR_VALUE_MAX)
    expect(text.length).toBeGreaterThan(3500)
    const started = performance.now()
    scrubText(text)
    // Proves the rules do not backtrack super-linearly on a text at the scan cap; the audit measured about 50 ms, so 2 s keeps at least 40x headroom.
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it.each([
    [
      'a run of path segments',
      `/${'a/'.repeat(4 * ERROR_VALUE_MAX)}`.slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
    [
      'repeated userinfo with no space',
      'a://b@'.repeat(4 * ERROR_VALUE_MAX).slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
    ['a dotted local part before one @', `${'a.'.repeat(2 * ERROR_VALUE_MAX - 10)}@b`],
  ])('worst-case 4 KB shapes the timing test does not cover: %s', (_label, shape) => {
    // A trailing space keeps the whole shape inside the scan cap's cut.
    const text = `${shape} `
    expect(text.length).toBeGreaterThan(4 * ERROR_VALUE_MAX - 30)
    const started = performance.now()
    scrubText(text)
    // Proves the rules stay linear on the three worst shapes at the scan cap; each measured 29-56 ms (five runs each), so 2 s keeps at least 35x headroom.
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('scrubs a secret that appears after replacements shortened the text', () => {
    const jwt = 'eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl'
    expect(scrubText(`${jwt} jane@example.com`)).toBe('[jwt] [email]')
  })
})
