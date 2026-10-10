/**
 * @file Seeded generators for the scrubber's differential gate. Each case is
 * a text built from one to four pieces, every piece drawn from a family of
 * shapes the scrubber must handle, and it records the secret values it
 * planted, so a gate can ask whether any of them is left in view. A case
 * depends only on (seed, index): the same pair always gives the same text.
 * Every secret is built at run time from random characters, so no committed
 * line holds a secret-shaped literal.
 */

/**
 * A random number generator returning a float in [0, 1).
 */
type Rng = () => number

/**
 * One generated input and the secret values planted in it.
 */
export interface GateCase {
  /**
  The text handed to the scrubber.
   */
  input: string
  /**
  Every secret value the text holds, each at least 8 characters.
   */
  planted: string[]
  /**
  The families its pieces came from, joined by `+`.
   */
  family: string
}

/**
 * mulberry32: a small, fast, seedable generator.
 * @param seed - Any 32-bit integer.
 * @returns A generator of floats in [0, 1).
 */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * The generator for one case: the seed and the index mixed into one state.
 * @param seed - The run's seed.
 * @param index - The case's index in the run.
 * @returns A generator private to that case.
 */
function caseRng(seed: number, index: number): Rng {
  return mulberry32(
    Math.imul(seed ^ 0x9e_37_79_b9, 0x85_eb_ca_6b) ^ Math.imul(index, 0xc2_b2_ae_35)
  )
}

/**
 * A text and the secrets it holds.
 */
interface Piece {
  text: string
  planted: string[]
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const ALNUM = `${LOWER}${UPPER}${DIGITS}`
const JWT_ALPHABET = `${ALNUM}-_`
const HEX = '0123456789abcdef'

/**
 * An integer in [0, limit).
 * @param rng - The generator.
 * @param limit - The exclusive upper bound.
 * @returns The integer.
 */
function int(rng: Rng, limit: number): number {
  return Math.floor(rng() * limit)
}

/**
 * One element of a list.
 * @param rng - The generator.
 * @param items - A non-empty list.
 * @returns The chosen element.
 */
function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[int(rng, items.length)] as T
}

/**
 * True with the given probability.
 * @param rng - The generator.
 * @param probability - A number in [0, 1].
 * @returns The outcome.
 */
function isRolled(rng: Rng, probability: number): boolean {
  return rng() < probability
}

/**
 * A run of characters drawn from an alphabet.
 * @param rng - The generator.
 * @param alphabet - The characters to draw from.
 * @param length - The run's length.
 * @returns The run.
 */
function run(rng: Rng, alphabet: string, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) out += alphabet.charAt(int(rng, alphabet.length))
  return out
}

/**
 * A password-like value: `zq`, an uppercase letter, a digit and 6 to 12
 * random letters and digits, so it is distinctive and never a word.
 * @param rng - The generator.
 * @returns The value.
 */
function password(rng: Rng): string {
  return `zq${pick(rng, [...UPPER])}${pick(rng, [...DIGITS])}${run(rng, ALNUM, 6 + int(rng, 7))}`
}

/**
 * A base64 run of the given length that the base64 rule calls a secret:
 * mostly uppercase and digits, with a `/` or `+` when asked.
 * @param rng - The generator.
 * @param length - The run's length.
 * @param hasSlash - Whether to include `/` and `+`.
 * @returns The run.
 */
function base64Run(rng: Rng, length: number, hasSlash: boolean): string {
  const alphabet = hasSlash
    ? `${UPPER}${DIGITS}${LOWER}${UPPER}/+`
    : `${UPPER}${DIGITS}${LOWER}${UPPER}`
  let out = `${pick(rng, [...UPPER])}${pick(rng, [...DIGITS])}`
  out += run(rng, alphabet, length - 2)
  return out.slice(0, length)
}

/**
 * The AWS documentation's example secret access key, built from parts.
 */
const AWS_DOC_SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/')

/**
 * A secret value of any shape the scrubber knows, with what it plants.
 * @param rng - The generator.
 * @returns The value and its planted parts.
 */
function secretValue(rng: Rng): Piece {
  switch (int(rng, 12)) {
    case 0:
    case 1:
    case 2: {
      const value = password(rng)
      return { text: value, planted: [value] }
    }
    case 3: {
      const first = password(rng)
      const second = password(rng)
      return { text: `${first} ${second}`, planted: [first, second] }
    }
    case 4: {
      const value = base64Run(rng, 40 + int(rng, 24), true)
      return { text: value, planted: [value] }
    }
    case 5: {
      return {
        text: AWS_DOC_SECRET,
        planted: AWS_DOC_SECRET.split('/').filter((part) => part.length >= 8),
      }
    }
    case 6: {
      const value = run(rng, HEX, 32 + int(rng, 16))
      return { text: value, planted: [value] }
    }
    case 7: {
      const value = `eyJ${run(rng, ALNUM, 12)}.${run(rng, ALNUM, 16)}.${run(rng, JWT_ALPHABET, 12)}`
      return { text: value, planted: [value.slice(3)] }
    }
    case 8: {
      const value = `${pick(rng, ['phc_', 'phx_'])}${run(rng, ALNUM, 20)}`
      return { text: value, planted: [value.slice(4)] }
    }
    case 9: {
      const body = run(rng, ALNUM, 16)
      const value = `${pick(rng, ['sk_test_', 'rk_live_', 'xoxb-', 'GOCSPX-'])}${body}`
      return { text: value, planted: [body] }
    }
    case 10: {
      const value = `${password(rng)}${pick(rng, ['/', '+', '='])}${run(rng, ALNUM, 8)}`
      return { text: value, planted: [value] }
    }
    default: {
      const inner = password(rng)
      return { text: `${run(rng, LOWER, 3)}-${inner}`, planted: [inner] }
    }
  }
}

const SECRET_KEYS = [
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'pass_phrase',
  'passcode',
  'passkey',
  'token',
  'tokens',
  'access_token',
  'refresh_token',
  'id_token',
  'apiKey',
  'api_key',
  'api-key',
  'x-api-key',
  'secret',
  'client_secret',
  'secret_key',
  'secretKey',
  'signing_key',
  'private-key',
  'session',
  'sessionId',
  'sid',
  'credential',
  'credentials',
  'signature',
  'sig',
  'hmac',
  'nonce',
  'jwt',
  'otp',
  'otp_code',
  'mfa_code',
  'recovery_code',
  'pin',
  'user_pin',
  'pin_code',
  'SAMLResponse',
  'mfa_response',
  'code_verifier',
  'authorization_code',
  'MY_KEY',
  'key',
]

const HEADER_KEYS = [
  'Authorization',
  'authorization',
  'Proxy-Authorization',
  'auth',
  'Cookie',
  'cookie',
  'Set-Cookie',
  'x-auth',
]

const SEPARATORS = ['=', ': ', ':', ' = ', '=>', ' => ', '%3D', '%3A', '&#61;', '&#58;', '=', ':']

const QUOTES = ['', '', '', '"', "'", String.raw`\"`, String.raw`\'`, '%22', '"']

const SCHEMES = [
  'Bearer',
  'Basic',
  'Token',
  'Digest',
  'OAuth',
  'Negotiate',
  'Custom',
  'AWS4-HMAC-SHA256',
  'bearer',
]

const PLACEHOLDERS = [
  '[redacted]',
  '[token]',
  '[secret]',
  '[email]',
  '[query]',
  '[fragment]',
  '[jwt]',
  '[ip]',
  '[phone]',
  '[value]',
  '[credentials]',
  '[posthog-key]',
]

const WORDS = [
  'failed',
  'error',
  'the',
  'request',
  'missing',
  'null',
  'undefined',
  'true',
  'connect',
  'ECONNREFUSED',
  'at',
  'value',
  'please',
  'retry',
  'Unexpected',
  'response',
  'code',
  'key',
  'user',
  'login',
  'invalid',
  'oauth',
  'grant_type',
  'authorize',
]

const GLUE = [
  ' ',
  ' ',
  ' ',
  ', ',
  '',
  '/',
  ': ',
  '\n',
  ' (',
  '"',
  "'",
  '&',
  '; ',
  '=',
  '?',
  '#',
  ' ',
  '\t',
  '.',
  '-',
  '_',
  '[',
  ']',
  '}',
  '{',
  '\\',
]

const DOMAINS = [
  'example.com',
  'example-corp.co.uk',
  'mail.example.com',
  'localhost',
  '[192.0.2.1]',
]

const AT_FORMS = ['@', '@', '@', '%40', '%2540', '＠', '﹫']

/**
 * A secret value wrapped in an optional quote, the close sometimes missing.
 * @param rng - The generator.
 * @param quote - The opening quote, or ''.
 * @returns The quoted value.
 */
function quotedValue(rng: Rng, quote: string): Piece {
  const value = isRolled(rng, 0.15) ? arrayValue(rng) : secretValue(rng)
  const isUnbalanced = isRolled(rng, 0.15)
  const tail = isRolled(rng, 0.2)
    ? pick(rng, [' more words', ', next', '; rest', '&x=1', ' }', ')', ' [redacted] tail'])
    : ''
  return {
    text: `${quote}${value.text}${isUnbalanced ? '' : quote}${tail}`,
    planted: value.planted,
  }
}

/**
 * An array of secrets (`["a", "b"]`), sometimes unclosed.
 * @param rng - The generator.
 * @returns The array text.
 */
function arrayValue(rng: Rng): Piece {
  const first = password(rng)
  const second = password(rng)
  const quote = pick(rng, ['"', "'", ''])
  const close = isRolled(rng, 0.85) ? ']' : ''
  return {
    text: `[${quote}${first}${quote}, ${quote}${second}${quote}${close}`,
    planted: [first, second],
  }
}

/**
 * A secret-named key and its value, in every separator, quote and nesting
 * form: plain, quoted, unbalanced, a later key inside an unquoted value, a
 * placeholder inside the value.
 * @param rng - The generator.
 * @returns The piece.
 */
function keyValue(rng: Rng): Piece {
  const key = `${isRolled(rng, 0.15) ? pick(rng, ['my_', 'x-', 'user', 'db_', 'MY_']) : ''}${pick(rng, SECRET_KEYS)}`
  const keyQuote = pick(rng, QUOTES)
  const separator = pick(rng, SEPARATORS)
  const valueQuote = pick(rng, QUOTES)
  const prefix = isRolled(rng, 0.2)
    ? pick(rng, ['?', '&', '{', '{ ', '(', '%26', '%3F', '&amp;', '#'])
    : ''
  const value = quotedValue(rng, valueQuote)
  let text = `${prefix}${keyQuote}${key}${keyQuote}${separator}${value.text}`
  const planted = [...value.planted]
  if (isRolled(rng, 0.3)) {
    const nested = keyValue(rng)
    const join = pick(rng, [
      ' ',
      ' a ',
      ' [redacted] ',
      ' x.ts',
      ', ',
      '&',
      '',
      ' word ',
      ' #[fragment] ',
    ])
    text += `${join}${nested.text}`
    planted.push(...nested.planted)
  }
  return { text, planted }
}

/**
 * An Authorization or Cookie header line: a scheme and its parameters, with
 * plain, single or escaped outer quotes.
 * @param rng - The generator.
 * @returns The piece.
 */
function header(rng: Rng): Piece {
  const key = pick(rng, HEADER_KEYS)
  const outer = pick(rng, ['', '', "'", '"', String.raw`\"`])
  const scheme = pick(rng, SCHEMES)
  const planted: string[] = []
  let body: string
  switch (int(rng, 4)) {
    case 0: {
      const credential = password(rng)
      planted.push(credential)
      const extra = isRolled(rng, 0.3) ? ' ' + password(rng) : ''
      body = `${scheme} ${credential}${extra}`
      if (body.split(' ').length > 2) planted.push(body.split(' ', 3)[2] ?? '')
      break
    }
    case 1: {
      const names = [
        'username',
        'realm',
        'nonce',
        'response',
        'oauth_token',
        'oauth_signature',
        'cnonce',
        'uri',
      ]
      const quote = pick(rng, ['"', String.raw`\"`, ''])
      const parts = Array.from({ length: 2 + int(rng, 3) }, () => {
        const value = password(rng)
        planted.push(value)
        return `${pick(rng, names)}=${quote}${value}${quote}`
      })
      body = `${scheme} ${parts.join(', ')}`
      break
    }
    case 2: {
      const parts = Array.from({ length: 1 + int(rng, 3) }, () => {
        const value = password(rng)
        planted.push(value)
        const name = pick(rng, ['sid', 'theme', 'a', 'session', 'csrf'])
        const shown = isRolled(rng, 0.3) ? JSON.stringify(value) : value
        return `${name}=${shown}`
      })
      body = parts.join('; ')
      break
    }
    default: {
      const value = secretValue(rng)
      planted.push(...value.planted)
      body = value.text
    }
  }
  const close = isRolled(rng, 0.85) ? outer : ''
  const separator = pick(rng, [': ', '=', ':', ' = '])
  return {
    text: `${key}${separator}${outer}${body}${close}`,
    planted: planted.filter((value) => value.length >= 8),
  }
}

/**
 * A URL or path: userinfo, a `/reset/`-style token segment (sometimes with
 * a key name glued to its end), a query and a fragment.
 * @param rng - The generator.
 * @returns The piece.
 */
function url(rng: Rng): Piece {
  const planted: string[] = []
  let text = isRolled(rng, 0.6)
    ? pick(rng, ['https://', 'http://', 'postgres://', 'redis://', 'webpack://'])
    : '/'
  if (text !== '/' && isRolled(rng, 0.3)) {
    const secret = password(rng)
    planted.push(secret)
    text += `${pick(rng, ['user', 'jane', 'a.b'])}:${secret}@`
  }
  if (text !== '/') text += pick(rng, ['app.example.com', 'localhost:4040', 'h'])
  text += `/${pick(rng, ['app', 'api/v1', 'src/a', 'x'])}`
  if (isRolled(rng, 0.4)) {
    const token = password(rng)
    planted.push(token)
    text += `/${pick(rng, ['reset', 'verify', 'invite', 'accept'])}/${token}`
    if (isRolled(rng, 0.4)) {
      const value = secretValue(rng)
      planted.push(...value.planted)
      text += `${pick(rng, ['', '.ts', 'x.ts'])}${pick(rng, SECRET_KEYS)}${pick(rng, SEPARATORS)}${pick(rng, ['', '"'])}${value.text}`
    }
  }
  if (isRolled(rng, 0.45)) {
    const value = password(rng)
    planted.push(value)
    text += `?${pick(rng, ['a=1&', '', 'x=y&'])}${pick(rng, ['token', 'code', 'state', 'q', 'api_key'])}=${value}`
    if (isRolled(rng, 0.3))
      text += `&${pick(rng, ['b', 'redirect_uri'])}=${pick(rng, ['x', '/back'])}`
  }
  if (isRolled(rng, 0.35)) {
    const fragment = pick(rng, [
      'installation',
      'getting-started',
      'L10-L12',
      '[secret]',
      '[fragment]',
      `access_token=${password(rng)}`,
      run(rng, LOWER, 40 + int(rng, 25)),
      `foo-${run(rng, 'abcdef', 36)}`,
      `x-${password(rng)}`,
      `lsh-xoxb-${run(rng, LOWER, 12)}otp`,
    ])
    const secretPart = /zq[A-Z]\d\w+/.exec(fragment)?.[0]
    if (secretPart !== undefined) planted.push(secretPart)
    text += `#${fragment}`
  }
  return { text, planted }
}

/**
 * An email address in any `@` form, sometimes with a secret run joined by
 * `/` before its local part or a base64 run as its domain, or a package ref
 * that is not an address.
 * @param rng - The generator.
 * @returns The piece.
 */
function email(rng: Rng): Piece {
  const planted: string[] = []
  const local = pick(rng, ['jane', 'jane.doe', 'j+tag', '"jane doe"', 'user_1', 'zz'])
  if (local !== 'zz') planted.push(local.replaceAll('"', ''))
  const at = pick(rng, AT_FORMS)
  switch (int(rng, 5)) {
    case 0: {
      const secret = isRolled(rng, 0.5) ? AWS_DOC_SECRET : base64Run(rng, 30 + int(rng, 30), true)
      for (const part of secret.split('/')) if (part.length >= 8) planted.push(part)
      return {
        text: `${secret}${pick(rng, ['/', '.', '+', '-', ''])}${local}${at}${pick(rng, DOMAINS)}`,
        planted,
      }
    }
    case 1: {
      const secret = `${base64Run(rng, 12, false)}/${base64Run(rng, 10, false)}/${base64Run(rng, 18, false)}`
      for (const part of secret.split('/')) if (part.length >= 8) planted.push(part)
      return { text: `${pick(rng, ['', 'dir/'])}${local}@${secret}`, planted }
    }
    case 2: {
      return {
        text: pick(rng, [
          'react@canary',
          'pkg@workspace:*',
          '@scope/pkg@1.2.3',
          'actions/checkout@v4',
          'node@sha256',
          'react@npm:@preact/compat',
        ]),
        planted: [],
      }
    }
    default: {
      return { text: `${local}${at}${pick(rng, DOMAINS)}`, planted }
    }
  }
}

/**
 * Secret runs glued to each other, split by an address or a space, or glued
 * to a scheme, a phone number or an IP address.
 * @param rng - The generator.
 * @returns The piece.
 */
function runs(rng: Rng): Piece {
  const planted: string[] = []
  const parts: string[] = []
  const count = 1 + int(rng, 3)
  for (let index = 0; index < count; index += 1) parts.push(runPart(rng, planted))
  return { text: parts.join(pick(rng, ['', '', ' ', '-', '_', '/', '.'])), planted }
}

/**
 * One part of `runs`: a hex run, a scheme credential, a phone number or IP
 * address, a base64 run split in two, or any secret value.
 * @param rng - The generator.
 * @param planted - Where the part's secrets are added.
 * @returns The part's text.
 */
function runPart(rng: Rng, planted: string[]): string {
  switch (int(rng, 8)) {
    case 0: {
      const hex = run(rng, HEX, 32 + int(rng, 8))
      planted.push(hex)
      return hex
    }
    case 1: {
      const value = password(rng)
      planted.push(value)
      return `${pick(rng, ['Bearer ', 'Basic ', 'bearer '])}${value}${run(rng, UPPER, 4)}`
    }
    case 2: {
      return pick(rng, [
        '+1 415 555 0100',
        '+44 20 7946 0958',
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a sample address the scrubber must remove
        '10.1.2.3',
        '2001:db8::8a2e:370:7334',
        '::1',
      ])
    }
    case 3: {
      const first = base64Run(rng, 20 + int(rng, 25), isRolled(rng, 0.5))
      const second = base64Run(rng, 20 + int(rng, 25), isRolled(rng, 0.5))
      planted.push(first, second)
      const glue = pick(rng, [' ', 'jane@example.com', '@x', '[secret]', '.', '-', '_', '%2F', '='])
      return `${first}${glue}${second}`
    }
    default: {
      const value = secretValue(rng)
      planted.push(...value.planted)
      return value.text
    }
  }
}

/**
 * An OAuth `code` in a query, form body, JSON dump or prose, with and
 * without a word that names an OAuth exchange.
 * @param rng - The generator.
 * @returns The piece.
 */
function oauth(rng: Rng): Piece {
  const value = password(rng)
  const context = pick(rng, [
    '',
    'grant_type=authorization_code&',
    'OAuth callback failed: ',
    'authorize ',
    'redirect_uri=/cb&',
    'myoauthlib ',
  ])
  const form = pick(rng, [
    `code=${value}`,
    `code: '${value}'`,
    `{ "code": "${value}" }`,
    `?code=${value}&state=x`,
    `code=${value}&state=x`,
    `{\n  code: '${value}',\n  errno: -111\n}`,
    `code = Bearer ${value}`,
  ])
  return { text: `${context}${form}`, planted: [value] }
}

/**
 * Placeholders an earlier scrub wrote, standing where a carve-out once
 * kept text: before a key, inside a value, after a path token, as a
 * fragment, in quotes before an `@`.
 * @param rng - The generator.
 * @returns The piece.
 */
function placeholders(rng: Rng): Piece {
  const value = secretValue(rng)
  const ph = pick(rng, PLACEHOLDERS)
  const shapes = [
    `${ph}${pick(rng, SECRET_KEYS)}${pick(rng, SEPARATORS)}${value.text}`,
    `${pick(rng, SECRET_KEYS)}${pick(rng, SEPARATORS)}${ph} ${value.text}`,
    `${pick(rng, SECRET_KEYS)}${pick(rng, SEPARATORS)}${value.text} ${ph}`,
    `/reset/${ph}${pick(rng, SECRET_KEYS)}=${value.text}`,
    `https://h/x#${ph} = ${value.text}`,
    `"${ph}"@${value.text}`,
    `${ph}${value.text}`,
    `Bearer ${ph} ${value.text}`,
    `${pick(rng, SECRET_KEYS)}${pick(rng, SEPARATORS)}${ph}${value.text}`,
  ]
  return { text: pick(rng, shapes), planted: value.planted }
}

/**
 * Postgres and JSON input echoes.
 * @param rng - The generator.
 * @returns The piece.
 */
function postgres(rng: Rng): Piece {
  const value = password(rng)
  const shapes = [
    `Key (email)=(${value}) already exists.`,
    `Key (a, b)=(${value}, x(1)) is not present`,
    `invalid input syntax for type uuid: "${value}"`,
    `invalid input value for enum role: "${value}"`,
    `malformed array literal: "${value}"`,
    `value "${value}" is out of range for type integer`,
    `"${value}"... is not valid JSON`,
  ]
  return { text: pick(rng, shapes), planted: [value] }
}

/**
 * Harmless text: prose, identifiers, file paths, UUIDs and package refs,
 * which carry no secret.
 * @param rng - The generator.
 * @returns The piece.
 */
function prose(rng: Rng): Piece {
  const shapes = [
    () => Array.from({ length: 1 + int(rng, 5) }, () => pick(rng, WORDS)).join(' '),
    () =>
      `at ${pick(rng, ['SessionProvider', 'a-very-long-kebab-identifier-for-the-tenant-switcher', 'Foo.#bar'])} (/src/${pick(rng, ['a', 'states'])}/${pick(rng, ['x', 'session'])}.ts:${int(rng, 99)}:${int(rng, 9)})`,
    () => '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    () =>
      `/app/src/services/${pick(rng, ['errors', 'node_modules'])}/${pick(rng, ['x', 'pkg@4.0.0'])}`,
    () =>
      pick(rng, [
        'Missing token: please log in',
        'Unexpected response: 502',
        'error code 23505',
        'status code: 404',
      ]),
  ]
  return { text: pick(rng, shapes)(), planted: [] }
}

/**
 * The families and their weights.
 */
const FAMILIES: readonly (readonly [string, number, (rng: Rng) => Piece])[] = [
  ['kv', 26, keyValue],
  ['header', 10, header],
  ['url', 14, url],
  ['email', 10, email],
  ['runs', 10, runs],
  ['oauth', 6, oauth],
  ['placeholder', 8, placeholders],
  ['postgres', 4, postgres],
  ['prose', 12, prose],
]

const FAMILY_WEIGHT = FAMILIES.reduce((sum, [, weight]) => sum + weight, 0)

/**
 * One piece from a family chosen by weight.
 * @param rng - The generator.
 * @returns The piece and its family's name.
 */
function anyPiece(rng: Rng): Piece & { family: string } {
  let roll = rng() * FAMILY_WEIGHT
  for (const [name, weight, make] of FAMILIES) {
    roll -= weight
    if (roll < 0) return { ...make(rng), family: name }
  }
  const [name, , make] = FAMILIES[0] as (typeof FAMILIES)[number]
  return { ...make(rng), family: name }
}

/**
 * The corpus case at (seed, index): one to four pieces joined by glue.
 * @param seed - The run's seed.
 * @param index - The case's index.
 * @returns The case.
 */
export function corpusCase(seed: number, index: number): GateCase {
  const rng = caseRng(seed, index)
  const count = 1 + int(rng, 4)
  const pieces = Array.from({ length: count }, () => anyPiece(rng))
  let input = ''
  for (const [position, piece] of pieces.entries()) {
    input += position === 0 ? '' : pick(rng, GLUE)
    input += piece.text
  }
  return {
    input,
    planted: pieces.flatMap((piece) => piece.planted).filter((value) => value.length >= 8),
    family: pieces.map((piece) => piece.family).join('+'),
  }
}

/**
 * Characters a hunt mutation inserts: delimiters, quotes, escapes, glue and
 * the starts of keys, placeholders and encodings.
 */
const MUTATION_INSERTS = [
  '"',
  "'",
  String.raw`\"`,
  '\\',
  '[',
  ']',
  '=',
  ': ',
  '&',
  '?',
  '#',
  '/',
  '@',
  ' ',
  '\n',
  ',',
  ';',
  '}',
  ')',
  '%22',
  '%3D',
  'token=',
  'pwd = ',
  'authorization: ',
  'x.ts',
  '/reset/',
  'Bearer ',
  '[redacted]',
  '[token]',
  '#[fragment]',
  '[email]',
  '[secret]',
]

/**
 * The hunt case at (seed, index): a corpus case mutated two to six times by
 * inserting delimiters, keys and placeholders, deleting a span, or gluing
 * another case to it. Planted values cut by a mutation still count where
 * their windows survive.
 * @param seed - The run's seed.
 * @param index - The case's index.
 * @returns The case.
 */
export function huntCase(seed: number, index: number): GateCase {
  const base = corpusCase(seed, index)
  const rng = caseRng(seed ^ 0x5b_d1_e9_95, index)
  let { input } = base
  const planted = [...base.planted]
  const mutations = 2 + int(rng, 5)
  for (let step = 0; step < mutations; step += 1) {
    input = mutated(rng, input, planted, corpusCase(seed + 1, index * 7 + step))
  }
  return { input, planted, family: `hunt:${base.family}` }
}

/**
 * One hunt mutation at a random place: an insert, a deletion of one to three
 * characters, or another case glued in.
 * @param rng - The generator.
 * @param input - The text so far.
 * @param planted - Where a glued case's secrets are added.
 * @param other - The case glued in when that mutation is drawn.
 * @returns The mutated text.
 */
function mutated(rng: Rng, input: string, planted: string[], other: GateCase): string {
  const at = int(rng, input.length + 1)
  switch (int(rng, 4)) {
    case 0:
    case 1: {
      return `${input.slice(0, at)}${pick(rng, MUTATION_INSERTS)}${input.slice(at)}`
    }
    case 2: {
      return `${input.slice(0, at)}${input.slice(at + 1 + int(rng, 3))}`
    }
    default: {
      planted.push(...other.planted)
      return `${input.slice(0, at)}${pick(rng, ['', ' ', '='])}${other.input}${input.slice(at)}`
    }
  }
}
