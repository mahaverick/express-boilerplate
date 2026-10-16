/**
 * @file Signed list cursors. A cursor is base64url JSON
 * `{ v, sort, keys, scope }`, a `.`, and an HMAC-SHA256 of the JSON part
 * under `CURSOR_SECRET`. `scope` hashes the request's effective search,
 * filters and sort, so a cursor only resumes the list it came from.
 * Verification throws `InvalidCursorError` for anything else; it never
 * returns a partial value.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { cursorSecret } from '@/configs/env.config'
import { InvalidCursorError } from '@/errors/list-errors'

/**
 * The cursor format version. A cursor carrying another is refused.
 */
export const CURSOR_VERSION = 1

/**
 * The longest cursor accepted, in characters (a cursor is base64url and a
 * dot, so one character is one byte). Room for any cursor the server issues:
 * a 255-character key is at most 1,530 bytes of JSON (a control character
 * escapes to six), and with a uuid, the sort, the scope and the signature
 * that encodes to about 2,300 characters.
 */
export const MAX_CURSOR_LENGTH = 4096

/**
 * One value in a cursor's `keys`: a sort value, or the row id.
 */
export type CursorKey = string | number

/**
 * What a list request's scope is computed from: the search as parsed, the
 * sort key and every filter after its default applied.
 */
export interface ListScopeInput {
  search: string | undefined
  sort: string
  filters: Readonly<Record<string, unknown>>
}

/**
 * The scope's search slot when the request has none: JSON null, which no search text can equal.
 */
// eslint-disable-next-line unicorn/no-null -- the scope hashes JSON null for no search
const NO_SEARCH = null

/**
 * The decoded payload's shape, before its keys are checked against the sort.
 */
const cursorKeySchema = z.union([z.string(), z.number()])

const payloadSchema = z.strictObject({
  v: z.number(),
  sort: z.string(),
  keys: z.array(cursorKeySchema),
  scope: z.string(),
})

/**
 * Code-unit order, the order `Array#sort` gives strings by default, spelled out.
 * @param a - One string.
 * @param b - Another.
 * @returns Negative, zero or positive.
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/**
 * A filter value in its canonical form: arrays sorted and deduplicated,
 * anything else as it is.
 * @param value - A parsed filter value.
 * @returns The canonical value.
 */
function canonicalValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return [...new Set(value.map(String))].toSorted(compareText)
}

/**
 * The scope hash of one list request: SHA-256 over the search, the sort and
 * the filters in key order, absent filters left out.
 * @param input - The search, sort and effective filters.
 * @returns The hash, base64url.
 */
export function listScope(input: ListScopeInput): string {
  const filters = Object.keys(input.filters)
    .toSorted(compareText)
    .filter((name) => input.filters[name] !== undefined)
    .map((name) => [name, canonicalValue(input.filters[name])])
  const canonical = JSON.stringify([input.search ?? NO_SEARCH, input.sort, filters])
  return createHash('sha256').update(canonical).digest('base64url')
}

/**
 * The HMAC of a cursor's JSON part.
 * @param body - The base64url JSON part.
 * @returns The raw signature.
 */
function signatureOf(body: string): Buffer {
  return createHmac('sha256', cursorSecret()).update(body).digest()
}

/**
 * Sign a page boundary as a cursor.
 * @param sort - The sort key the page was read under.
 * @param scope - The request's `listScope`.
 * @param keys - The boundary row's sort values, then its id.
 * @returns The opaque cursor.
 */
export function signCursor(sort: string, scope: string, keys: readonly CursorKey[]): string {
  const body = Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, sort, keys, scope }),
    'utf8'
  ).toString('base64url')
  return `${body}.${signatureOf(body).toString('base64url')}`
}

/**
 * Verify a cursor against the request it came back with, and decode its keys.
 * @param raw - The cursor as the client sent it.
 * @param expected - What the request expects.
 * @param expected.sort - The request's sort key.
 * @param expected.scope - The request's `listScope`.
 * @param expected.keys - The schema each key must meet; their count is the key count.
 * @returns The keys.
 * @throws {InvalidCursorError} When the cursor is oversize, unsigned or
 *   tampered with, from another version, sort or scope, or its keys have
 *   the wrong count or types.
 */
export function verifyCursor(
  raw: string,
  expected: { sort: string; scope: string; keys: readonly z.ZodType<CursorKey>[] }
): CursorKey[] {
  // An empty cursor has no signature segment, so it is refused below like any other.
  if (raw.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError()
  const [body, signature, extra] = raw.split('.', 3)
  if (body === undefined || signature === undefined || extra !== undefined) {
    throw new InvalidCursorError()
  }
  const given = Buffer.from(signature, 'base64url')
  const wanted = signatureOf(body)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new InvalidCursorError()
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError()
  }
  const payload = payloadSchema.safeParse(decoded)
  if (
    !payload.success ||
    payload.data.v !== CURSOR_VERSION ||
    payload.data.sort !== expected.sort ||
    payload.data.scope !== expected.scope ||
    payload.data.keys.length !== expected.keys.length
  ) {
    throw new InvalidCursorError()
  }
  return payload.data.keys.map((key, index) => {
    const parsed = expected.keys[index]?.safeParse(key)
    if (parsed === undefined || !parsed.success) throw new InvalidCursorError()
    return parsed.data
  })
}
