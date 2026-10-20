/**
 * @file Signed list cursors: a round trip, and every refusal the contract
 * names (oversize, bad signature, wrong version, another sort or scope,
 * wrong key count or types), each as the one `InvalidCursorError`.
 */
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cursorSecret } from '@/configs/env.config'
import { CURSOR_INVALID_CODE, InvalidCursorError } from '@/errors/list-errors'
import {
  bindScope,
  CURSOR_VERSION,
  listScope,
  MAX_CURSOR_LENGTH,
  signCursor,
  verifyCursor,
} from '@/utilities/list-cursor.utilities'

const secretOverride = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, cursorSecret: () => secretOverride.value ?? actual.cursorSecret() }
})

afterEach(() => {
  secretOverride.value = undefined
})

const ID = '0199c4a2-0000-7000-8000-000000000001'
const SCOPE = listScope({ search: undefined, sort: 'name', filters: {} })
const KEYS = [z.string(), z.uuid()] as const

const EXPECTED = { sort: 'name', scope: SCOPE, keys: KEYS }

/**
 * A cursor body signed with the real key, so only the payload is wrong.
 */
function signedBody(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', cursorSecret()).update(body).digest('base64url')
  return `${body}.${signature}`
}

/**
 * Runs `verifyCursor` with the default expectation and returns what it threw.
 */
function refusalOf(raw: string, expected = EXPECTED): unknown {
  try {
    verifyCursor(raw, expected)
  } catch (error) {
    return error
  }
  return undefined
}

describe('signCursor and verifyCursor', () => {
  it('round-trips the keys under the same sort and scope', () => {
    const cursor = signCursor('name', SCOPE, ['acme', ID])
    expect(verifyCursor(cursor, { sort: 'name', scope: SCOPE, keys: KEYS })).toEqual(['acme', ID])
  })

  it('verifies a body signed by the test helper, so the helper signs as signCursor does', () => {
    const body = { v: CURSOR_VERSION, sort: 'name', keys: ['acme', ID], scope: SCOPE }
    expect(verifyCursor(signedBody(body), EXPECTED)).toEqual(['acme', ID])
    expect(signedBody(body)).toBe(signCursor('name', SCOPE, ['acme', ID]))
  })

  it('signs with the configured secret, so another secret refuses the cursor', () => {
    secretOverride.value = 'f'.repeat(32)
    const cursor = signCursor('name', SCOPE, ['acme', ID])
    expect(verifyCursor(cursor, EXPECTED)).toEqual(['acme', ID])
    secretOverride.value = 'g'.repeat(32)
    expect(refusalOf(cursor)).toBeInstanceOf(InvalidCursorError)
  })

  it('throws one InvalidCursorError shape with the validation body and code', () => {
    const error = refusalOf('nonsense')
    expect(error).toBeInstanceOf(InvalidCursorError)
    expect(error).toMatchObject({
      statusCode: 400,
      message: 'This list link is out of date. Reload the list from its first page.',
      code: CURSOR_INVALID_CODE,
      errors: { cursor: ['This list link is out of date. Reload the list from its first page.'] },
    })
  })

  it.each([
    ['oversize', oversizeCursor()],
    ['empty', ''],
    ['no signature', Buffer.from('{}').toString('base64url')],
    ['an extra segment', `${signCursor('name', SCOPE, ['acme', ID])}.x`],
    ['a flipped signature character', flipSignature(signCursor('name', SCOPE, ['acme', ID]))],
    ['a padded signature', `${signCursor('name', SCOPE, ['acme', ID])}=`],
    ['a garbage-suffixed signature', `${signCursor('name', SCOPE, ['acme', ID])}*`],
    [
      'a signature with a stray character',
      insertIntoSignature(signCursor('name', SCOPE, ['acme', ID])),
    ],
    ['a body that is not JSON', signedBodyRaw('not json')],
    [
      'another version',
      signedBody({ v: CURSOR_VERSION + 1, sort: 'name', keys: ['acme', ID], scope: SCOPE }),
    ],
    [
      'an unknown field',
      signedBody({ v: CURSOR_VERSION, sort: 'name', keys: ['acme', ID], scope: SCOPE, x: 1 }),
    ],
    ['too few keys', signCursor('name', SCOPE, ['acme'])],
    ['too many keys', signCursor('name', SCOPE, ['acme', ID, 'extra'])],
    ['a key of the wrong type', signCursor('name', SCOPE, [7, ID])],
    ['an id that is not a uuid', signCursor('name', SCOPE, ['acme', 'not-a-uuid'])],
  ])('refuses %s', (_label, raw) => {
    expect(refusalOf(raw)).toBeInstanceOf(InvalidCursorError)
  })

  it('refuses a cursor issued under another sort', () => {
    const cursor = signCursor('-created', SCOPE, ['acme', ID])
    expect(refusalOf(cursor)).toBeInstanceOf(InvalidCursorError)
  })

  it('refuses a cursor issued under another scope', () => {
    const other = listScope({ search: 'acme', sort: 'name', filters: {} })
    expect(refusalOf(signCursor('name', other, ['acme', ID]))).toBeInstanceOf(InvalidCursorError)
  })

  // 255 characters is the tenants.name limit; 界 is 3 UTF-8 bytes, and a control character escapes to 6 in JSON.
  it.each([
    ['CJK', '界'],
    ['emoji', '\u{1F600}'],
    ['control characters', '\u{1}'],
  ])('round-trips a 255-character key made of %s, under the length cap', (_label, character) => {
    const text = character.repeat(255)
    const cursor = signCursor('name', SCOPE, [text, ID])
    expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH)
    expect(verifyCursor(cursor, { sort: 'name', scope: SCOPE, keys: KEYS })).toEqual([text, ID])
  })
})

describe('listScope', () => {
  it('is the same for reordered and repeated comma values', () => {
    expect(
      listScope({
        search: undefined,
        sort: 'email',
        filters: { status: ['inactive', 'active', 'active'] },
      })
    ).toBe(
      listScope({ search: undefined, sort: 'email', filters: { status: ['active', 'inactive'] } })
    )
  })

  it('ignores filter key order and absent filters', () => {
    expect(
      listScope({
        search: 'x',
        sort: 'email',
        filters: { staff: true, verified: undefined, status: ['active'] },
      })
    ).toBe(listScope({ search: 'x', sort: 'email', filters: { status: ['active'], staff: true } }))
  })

  it('differs when the search, the sort or a filter differs', () => {
    const base = { search: 'x', sort: 'email', filters: { status: ['active'] } }
    const scope = listScope(base)
    expect(listScope({ ...base, search: 'y' })).not.toBe(scope)
    expect(listScope({ ...base, search: undefined })).not.toBe(scope)
    expect(listScope({ ...base, sort: 'created' })).not.toBe(scope)
    expect(listScope({ ...base, filters: { status: ['inactive'] } })).not.toBe(scope)
  })
})

/**
 * A correctly signed cursor longer than the cap, with keys the schema accepts,
 * so only the length check can refuse it.
 */
function oversizeCursor(): string {
  const cursor = signCursor('name', SCOPE, ['x'.repeat(3100), ID])
  expect(cursor.length).toBeGreaterThan(MAX_CURSOR_LENGTH)
  return cursor
}

/**
 * A cursor with a character the base64url alphabet lacks inserted mid-signature.
 */
function insertIntoSignature(cursor: string): string {
  const dot = cursor.lastIndexOf('.')
  return `${cursor.slice(0, dot + 10)}!${cursor.slice(dot + 10)}`
}

/**
 * A cursor with the first character of its signature changed. The first
 * character, not the last: a base64url string's last character can carry
 * padding bits that decode to the same bytes.
 */
function flipSignature(cursor: string): string {
  const dot = cursor.lastIndexOf('.')
  const changed = cursor[dot + 1] === 'A' ? 'B' : 'A'
  return `${cursor.slice(0, dot + 1)}${changed}${cursor.slice(dot + 2)}`
}

/**
 * A correctly signed cursor whose body decodes to `text`, not JSON.
 */
function signedBodyRaw(text: string): string {
  const body = Buffer.from(text, 'utf8').toString('base64url')
  const signature = createHmac('sha256', cursorSecret()).update(body).digest('base64url')
  return `${body}.${signature}`
}

describe('bindScope', () => {
  const scope = listScope({ search: undefined, sort: 'name', filters: {} })

  it('gives each bound value its own scope, whatever the key order', () => {
    expect(bindScope(scope, { tenantId: 'a' })).not.toBe(bindScope(scope, { tenantId: 'b' }))
    expect(bindScope(scope, { tenantId: 'a' })).not.toBe(scope)
    expect(bindScope(scope, { a: '1', b: '2' })).toBe(bindScope(scope, { b: '2', a: '1' }))
  })

  it('gives each request scope its own bound scope', () => {
    const other = listScope({ search: 'x', sort: 'name', filters: {} })
    expect(bindScope(scope, { tenantId: 'a' })).not.toBe(bindScope(other, { tenantId: 'a' }))
  })
})
