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
  'at a-very-long-kebab-identifier-for-the-tenant-switcher-panel (x.js)',
  'at my_very_long_snake_case_identifier_for_the_module_x_y (x.js)',
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
        'ip',
        'phone',
        'path-token',
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
    [
      'a reset path of repeated key=null fields',
      `/reset/${'token=null,'.repeat(4 * ERROR_VALUE_MAX)}`.slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
    [
      'a replaced value joined to a fragment of path segments',
      `/x/pwd=[a b]#${'a/'.repeat(4 * ERROR_VALUE_MAX)}`.slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
    [
      'nested open arrays',
      `token: ${'a = [x '.repeat(4 * ERROR_VALUE_MAX)}`.slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
    [
      'a value over repeated reset paths with an &code field',
      `password=${'/reset/a&code="x y" '.repeat(4 * ERROR_VALUE_MAX)}`.slice(
        0,
        4 * ERROR_VALUE_MAX - 1
      ),
    ],
    [
      'a value running through repeated keys',
      `token: ${'a pwd: '.repeat(4 * ERROR_VALUE_MAX)}`.slice(0, 4 * ERROR_VALUE_MAX - 1),
    ],
  ])('worst-case 4 KB shapes the timing test does not cover: %s', (_label, shape) => {
    // A trailing space keeps the whole shape inside the scan cap's cut.
    const text = `${shape} `
    expect(text.length).toBeGreaterThan(4 * ERROR_VALUE_MAX - 30)
    const started = performance.now()
    scrubText(text)
    // Proves the worst shapes stay bounded at the scan cap: several are quadratic, and only SCAN_MAX keeps them cheap; each measured at most 60 ms (median of seven runs), so 2 s keeps at least 33x headroom.
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('scrubs a secret that appears after replacements shortened the text', () => {
    const jwt = 'eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl'
    expect(scrubText(`${jwt} jane@example.com`)).toBe('[jwt] [email]')
  })
})

describe('scrubText on identifiers', () => {
  it.each([
    'at a-very-long-kebab-identifier-for-the-tenant-switcher-panel (x.js)',
    'at my_very_long_snake_case_identifier_for_the_module_x_y (x.js)',
  ])('keeps the identifier in %s', (input) => {
    expect(scrubText(input)).toBe(input)
  })
})

describe('scrubText on email edge forms', () => {
  it.each([
    ['no TLD', 'invite failed for jane@localhost', 'jane'],
    ['double-encoded %2540', 'invite failed for jane%2540example.com', 'jane'],
    ['fullwidth at', 'invite failed for jane＠example.com', 'jane'],
    ['quoted local part', 'invite failed for "jane doe"@example.com', 'jane doe'],
  ])('%s: the address is scrubbed', (_shape, input, local) => {
    expect(scrubText(input)).not.toContain(local)
  })
})

describe('scrubText on a secret glued to a preceding hex run', () => {
  const hex = 'a3f9'.repeat(8)

  it.each([
    ['posthog key', `${hex}phc_abcdef123`, 'phc_abcdef123'],
    ['jwt', `${hex}eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl`, 'eyJiIjoyfQ.c2lnbmF0dXJl'],
    ['bearer', `${hex}Bearer abc123secret`, 'abc123secret'],
  ])('%s: the first pass removes it', (_shape, input, secret) => {
    expect(scrubText(input)).not.toContain(secret)
  })

  it('is idempotent on the glued shape', () => {
    const once = scrubText(`${hex}phc_abcdef123`)
    expect(scrubText(once)).toBe(once)
  })
})

describe('scrubText on fragments', () => {
  it.each([
    'webpack://app/src/main.tsx#L5',
    'https://app.example.com/src/a.ts#L42-L48',
    'https://app.example.com/src/a.ts#L10C3-L12C8',
    'https://app.example.com/docs#installation',
    'https://app.example.com/docs#getting-started',
    'https://app.example.com/docs#authentication',
    'https://app.example.com/docs#design',
    'https://app.example.com/docs#keyboard-shortcuts',
    'https://app.example.com/docs#spinning',
  ])('keeps %s', (input) => {
    expect(scrubText(input)).toBe(input)
  })

  it.each([
    'abcdef123456',
    'piano-tiger-4815',
    'otp-123456',
    'pin_4821',
    'token_abcdefghijklmnop',
    'step2',
    'reset-code-words',
    'token-qyhilody',
    'tokens',
    'secrets',
    'passwords',
    'pins',
    'api-key',
    'session-replay',
  ])('scrubs the fragment #%s', (fragment) => {
    expect(scrubText(`https://app.example.com/reset-password#${fragment}`)).toBe(
      'https://app.example.com/reset-password#[fragment]'
    )
  })

  it('scrubs 200 random letters-then-digits fragments', () => {
    let seed = 12_345
    const next = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % limit
    }
    for (let index = 0; index < 200; index += 1) {
      const letters = Array.from({ length: 4 + next(10) }, () =>
        String.fromCodePoint(97 + next(26))
      ).join('')
      const digits = Array.from({ length: 1 + next(8) }, () => next(10)).join('')
      expect(scrubText(`https://app.example.com/x#${letters}${digits}`)).toBe(
        'https://app.example.com/x#[fragment]'
      )
    }
  })

  it('gives the same text twice for 300 random lowercase and hex-letter fragments', () => {
    let seed = 54_321
    const next = (limit: number): number => {
      seed = (seed * 1_103_515 + 12_345) % 2_147_483_648
      return seed % limit
    }
    for (let index = 0; index < 300; index += 1) {
      const alphabet = index % 2 === 0 ? 'abcdefghijklmnopqrstuvwxyz' : 'abcdef'
      const fragment = Array.from({ length: 1 + next(80) }, () =>
        alphabet.charAt(next(alphabet.length))
      ).join('')
      const once = scrubText(`https://app.example.com/docs#${fragment}`)
      expect(scrubText(once)).toBe(once)
    }
  })
})

describe('scrubText on an address with no TLD before punctuation, and on package refs', () => {
  it.each([
    'invite failed for jane@localhost: smtp down',
    'invite failed for jane@intranet!',
    'to=jane@localhost&x=1',
    'jane@localhost?x=1',
    'jane@corp/x',
  ])('scrubs the address in %s', (input) => {
    expect(scrubText(input)).not.toContain('jane')
  })

  it.each([
    'react@canary',
    'lodash@latest',
    'vitest@next',
    'actions/checkout@v4',
    'actions/setup-node@main',
    'node@sha256',
  ])('keeps the package ref %s', (input) => {
    expect(scrubText(input)).toBe(input)
  })
})

describe('scrubText on a package ref with a protocol', () => {
  it.each([
    'react@npm:@preact/compat',
    'pkg@workspace:*',
    'pkg@file:../local',
    'pkg@github:org/repo',
    'pkg@link:../x',
    'pkg@portal:../x',
    'pkg@patch:pkg@npm:1.0.0',
    'pkg@git+https://example.com/a.git',
  ])('keeps %s', (input) => {
    expect(scrubText(input)).toBe(input)
  })
})

describe('scrubText on quoted bare words and Digest', () => {
  it('escaped quote after an exempt bare word (JSON, double quote)', () => {
    expect(scrubText(String.raw`{"token": "null\"hunter2"}`)).not.toContain('hunter2')
  })

  it('escaped quote after an exempt bare word (single quote)', () => {
    expect(scrubText(String.raw`{'token': 'null\'hunter2'}`)).not.toContain('hunter2')
  })

  it('Digest header scrubs the username', () => {
    const header =
      'Authorization: Digest username="jane", realm="r", nonce="abc", uri="/x", response="6629fae49393a05397450978507c4ef1"'
    expect(scrubText(header)).not.toContain('jane')
  })

  it('Digest header scrubs a short response', () => {
    expect(scrubText('Authorization: Digest username="jane", response="abc12"')).not.toContain(
      'abc12'
    )
  })
})

describe('scrubText on the shapes it once let through', () => {
  it.each([
    [
      'unknown-scheme Authorization (header form)',
      'Authorization: Custom abc123secret',
      'abc123secret',
    ],
    ['unknown-scheme Authorization (kv form)', 'authorization=Custom abc123secret', 'abc123secret'],
    [
      'multi-param OAuth consumer key',
      'Authorization: OAuth oauth_consumer_key="ck123", oauth_token="tok456", oauth_signature="sig789"',
      'ck123',
    ],
    [
      'multi-param Digest username',
      'Authorization: Digest username="jane", realm="r", response="abc12"',
      'jane',
    ],
    [
      'multi-param Digest short response',
      'Authorization: Digest username="jane", realm="r", response="abc12"',
      'abc12',
    ],
    ['array-valued secret (JSON)', '{"password": ["hunter2", "x"]}', 'hunter2'],
    ['array-valued secret (plural key)', 'tokens: ["hunter2"]', 'hunter2'],
    ['short non-hex signature', 'sig=Zx9Kq2Lm', 'Zx9Kq2Lm'],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a sample address the scrubber must remove
    ['IPv4 address', 'connect failed from 10.1.2.3', '10.1.2.3'],
    ['phone number', 'sms to +1 415 555 0100 failed', '415 555 0100'],
    ['short opaque token in a path', 'GET /reset/abc123XYZ failed', 'abc123XYZ'],
    [
      'odd JWT shape (whitespace JSON header)',
      'token ewogICJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln rejected',
      'eyJzdWIiOiIxIn0',
    ],
  ])('%s: the value is scrubbed', (_shape, input, secret) => {
    expect(scrubText(input)).not.toContain(secret)
  })

  it('keeps a UUID, an id rather than a secret', () => {
    const text = 'user 3f2504e0-4f89-11d3-9a0c-0305e82c3301 not found'
    expect(scrubText(text)).toBe(text)
  })

  it('Basic Credential= is idempotent', () => {
    const once = scrubText('Basic Credential=abcdefgh')
    expect(scrubText(once)).toBe(once)
  })
})

describe('scrubText on single-quoted header values (util.inspect)', () => {
  it.each([
    [
      'Digest parameters',
      `{ authorization: 'Digest username="jane", realm="r", uri="/x", response="abc"' }`,
      ['jane', 'realm', '/x', 'abc'],
    ],
    [
      'OAuth parameters',
      `{ authorization: 'OAuth oauth_consumer_key="ck123", oauth_token="tok456"' }`,
      ['ck123', 'tok456'],
    ],
    [
      'a cookie list with a quoted pair',
      `{ cookie: 'theme="dark"; sid2=zqS4abc' }`,
      ['dark', 'zqS4abc'],
    ],
  ])('%s: no inner value survives', (_shape, input, secrets) => {
    const scrubbed = scrubText(input)
    for (const secret of secrets) expect(scrubbed).not.toContain(secret)
  })
})
