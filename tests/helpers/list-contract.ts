/**
 * @file The shared list contract suite. `describeListContract` runs, for one
 * list endpoint: the first page, next, prev back to the first page, every
 * sort read in pages and in one read (both ways), search, multi-value
 * filters, the exact total and the capped total, and the 400s (unknown
 * sort, `prev` with no cursor, a tampered, oversize or empty cursor, and a
 * cursor reused under another sort, search or filter, each the one
 * `CURSOR_INVALID` body). A list describes its rows
 * through a `ListContract`; `seed` inserts them in one statement, so rows
 * share a `created_at` and every sort's tiebreaker is exercised.
 */
import type { RequestListener } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from './request'

// eslint-disable-next-line unicorn/no-null -- the list contract sends JSON null for a missing cursor
const NONE = null

/**
 * The page part of a list response.
 */
interface PageBody {
  items: unknown[]
  page: {
    nextCursor: string | null
    prevCursor: string | null
    hasNext: boolean
    hasPrev: boolean
    limit: number
  }
  total?: { count: number; capped: boolean }
}

/**
 * A list response's envelope, narrowed to what the suite reads.
 */
interface Envelope {
  success: boolean
  data?: PageBody
  code?: string
  errors?: Record<string, string[]>
}

/**
 * One list endpoint, described for the shared suite.
 */
export interface ListContract {
  /**
  The describe title, e.g. `GET /api/v1/platform/tenants`.
   */
  name: string
  /**
  The app under test.
   */
  app: () => RequestListener
  /**
  The list's URL path, read after `setup` has run.
   */
  path: () => string
  /**
  Headers that authenticate a caller who may read the list.
   */
  headers: () => Record<string, string>
  /**
  Params that select this contract's rows and nothing else in the worker's database; merged into every request.
   */
  isolate: () => Record<string, string>
  /**
  Every whitelisted sort key, the default first.
   */
  sorts: readonly [string, ...string[]]
  /**
  Creates what every case needs (a caller, a tenant), once.
   */
  setup: () => Promise<void>
  /**
  Inserts `count` rows that `isolate` selects, in one statement.
   */
  seed: (count: number) => Promise<void>
  /**
  Deletes every row `seed` inserted.
   */
  clear: () => Promise<void>
  /**
  Deletes what `setup` created.
   */
  teardown: () => Promise<void>
  /**
  An item's id, for comparing pages; `item.id` when absent.
   */
  idOf?: (item: unknown) => string
  /**
  Rows `isolate` selects after `seed(5)`, when not 5: the caller's own membership adds one; the fixed flags registry has two.
   */
  visible?: number
  /**
  The page size the paging tests use; 2 unless the list holds too few rows for three pages.
   */
  pageSize?: number
  /**
  A search, isolated like every request, that selects exactly `count` rows after `seed(5)`.
   */
  search: { text: string; count: number }
  /**
  Filter queries, each with the number of rows it selects after `seed(5)`; one per filter, a comma list where the filter takes one.
   */
  filters?: readonly { query: Record<string, string>; count: number }[]
  /**
  False when the list cannot hold 1001 isolated rows (the fixed flags registry).
   */
  canCap?: boolean
}

/**
 * The id of an item, through the contract's `idOf` or `item.id`.
 * @param contract - The list.
 * @param item - One item of a page.
 * @returns Its id.
 */
function idOf(contract: ListContract, item: unknown): string {
  if (contract.idOf !== undefined) return contract.idOf(item)
  return String((item as { id: unknown }).id)
}

/**
 * GET the list with the contract's isolation and `query`.
 * @param contract - The list.
 * @param query - Params on top of `isolate()`.
 * @returns The status and envelope.
 */
async function get(
  contract: ListContract,
  query: Record<string, string>
): Promise<{ status: number; body: Envelope }> {
  const response = await request(contract.app())
    .get(contract.path())
    .query({ ...contract.isolate(), ...query })
    .set(contract.headers())
  return { status: response.status, body: response.body as Envelope }
}

/**
 * GET one page, failing the test unless it answered 200 with a page.
 * @param contract - The list.
 * @param query - Params on top of `isolate()`.
 * @returns The page.
 */
async function pageOf(contract: ListContract, query: Record<string, string>): Promise<PageBody> {
  const { status, body } = await get(contract, query)
  if (status !== 200 || body.data === undefined) {
    throw new Error(`expected a page, got ${String(status)}: ${JSON.stringify(body)}`)
  }
  return body.data
}

/**
 * Read every row a page at a time, forward, then back from the last page.
 * @param contract - The list.
 * @param query - The sort and any other params.
 * @returns The ids read forward, and the ids read backward put back in display order.
 */
async function walk(
  contract: ListContract,
  query: Record<string, string>
): Promise<{ forward: string[]; backward: string[] }> {
  const limit = String(contract.pageSize ?? 2)
  const forward: string[] = []
  let page = await pageOf(contract, { ...query, limit })
  forward.push(...page.items.map((item) => idOf(contract, item)))
  let steps = 0
  while (page.page.hasNext) {
    steps += 1
    if (steps > 50) throw new Error('the forward walk did not end')
    page = await pageOf(contract, { ...query, limit, cursor: String(page.page.nextCursor) })
    forward.push(...page.items.map((item) => idOf(contract, item)))
  }
  const backward = page.items.map((item) => idOf(contract, item))
  steps = 0
  while (page.page.hasPrev) {
    steps += 1
    if (steps > 50) throw new Error('the backward walk did not end')
    page = await pageOf(contract, {
      ...query,
      limit,
      direction: 'prev',
      cursor: String(page.page.prevCursor),
    })
    backward.unshift(...page.items.map((item) => idOf(contract, item)))
  }
  return { forward, backward }
}

/**
 * A cursor with the first character of its signature changed, so it does
 * not verify. The first, not the last: a base64url string's last character
 * can carry padding bits that decode to the same bytes.
 * @param cursor - A cursor the server issued.
 * @returns The tampered cursor.
 */
function tampered(cursor: string): string {
  const dot = cursor.lastIndexOf('.')
  const changed = cursor[dot + 1] === 'A' ? 'B' : 'A'
  return `${cursor.slice(0, dot + 1)}${changed}${cursor.slice(dot + 2)}`
}

/**
 * Register the shared list contract suite for one endpoint.
 * @param contract - The list.
 */
export function describeListContract(contract: ListContract): void {
  const visible = contract.visible ?? 5
  const size = String(contract.pageSize ?? 2)

  describe(`${contract.name} — list contract`, () => {
    beforeAll(() => contract.setup(), 60_000)
    afterAll(() => contract.teardown(), 60_000)

    describe('five rows', () => {
      beforeAll(() => contract.seed(5), 60_000)
      afterAll(() => contract.clear(), 60_000)

      it('pages forward, then back to the first page', async () => {
        const first = await pageOf(contract, { limit: size })
        expect(first.items).toHaveLength(Number(size))
        expect(first.page).toMatchObject({
          hasPrev: false,
          prevCursor: NONE,
          hasNext: true,
          limit: Number(size),
        })
        const second = await pageOf(contract, {
          limit: size,
          cursor: String(first.page.nextCursor),
        })
        expect(second.page.hasPrev).toBe(true)
        const back = await pageOf(contract, {
          limit: size,
          direction: 'prev',
          cursor: String(second.page.prevCursor),
        })
        expect(back.items).toEqual(first.items)
        expect(back.page).toMatchObject({ hasPrev: false, prevCursor: NONE, hasNext: true })
      })

      it.each(contract.sorts)('sort=%s reads every row once, in pages either way', async (sort) => {
        const whole = await pageOf(contract, { sort, limit: '100' })
        const ids = whole.items.map((item) => idOf(contract, item))
        expect(ids).toHaveLength(visible)
        expect(new Set(ids).size).toBe(visible)
        const { forward, backward } = await walk(contract, { sort })
        expect(forward).toEqual(ids)
        expect(backward).toEqual(ids)
      })

      it('reads a descending sort as the exact reverse of its ascending pair', async () => {
        const pairs = contract.sorts.filter((sort) => contract.sorts.includes(`-${sort}`))
        for (const sort of pairs) {
          const up = await pageOf(contract, { sort, limit: '100' })
          const down = await pageOf(contract, { sort: `-${sort}`, limit: '100' })
          expect(down.items.map((item) => idOf(contract, item))).toEqual(
            up.items.map((item) => idOf(contract, item)).toReversed()
          )
        }
      })

      it('searches', async () => {
        const found = await pageOf(contract, { search: contract.search.text, limit: '100' })
        expect(found.items).toHaveLength(contract.search.count)
      })

      it('filters, comma lists included', async () => {
        const filters = contract.filters ?? []
        for (const filter of filters) {
          const found = await pageOf(contract, { ...filter.query, limit: '100' })
          expect(found.items, JSON.stringify(filter.query)).toHaveLength(filter.count)
        }
      })

      it('counts exactly with total=1, and only then', async () => {
        const counted = await pageOf(contract, { total: '1' })
        const plain = await pageOf(contract, {})
        expect(counted.total).toEqual({ count: visible, capped: false })
        expect(plain.total).toBeUndefined()
      })

      it('refuses an unknown sort', async () => {
        const { status, body } = await get(contract, { sort: 'bogus' })
        expect(status).toBe(400)
        expect(body.errors?.sort?.[0]).toMatch(/^sort must be one of: /)
      })

      it('refuses prev with no cursor', async () => {
        const { status, body } = await get(contract, { direction: 'prev' })
        expect(status).toBe(400)
        expect(body.errors?.cursor).toEqual(['cursor is required when direction is prev.'])
      })

      it('refuses a tampered, oversize, empty or replayed cursor with one body', async () => {
        const first = await pageOf(contract, { limit: size })
        const cursor = String(first.page.nextCursor)
        const otherSort = contract.sorts[1]
        const otherFilter = contract.filters?.[0]?.query
        const refused: Record<string, string>[] = [
          { cursor: tampered(cursor) },
          { cursor: 'a'.repeat(4097) },
          { cursor: '' },
          { cursor, search: `${contract.isolate().search ?? ''}zzz` },
          ...(otherSort === undefined ? [] : [{ cursor, sort: otherSort }]),
          ...(otherFilter === undefined ? [] : [{ cursor, ...otherFilter }]),
        ]
        for (const query of refused) {
          const { status, body } = await get(contract, { limit: size, ...query })
          expect(status, JSON.stringify(query)).toBe(400)
          expect(body.code).toBe('CURSOR_INVALID')
          expect(body.errors).toEqual({ cursor: ['cursor is invalid.'] })
        }
      })
    })

    if (contract.canCap !== false) {
      describe('1001 rows', () => {
        beforeAll(() => contract.seed(1001), 60_000)
        afterAll(() => contract.clear(), 60_000)

        it('caps the total at 1000', async () => {
          const counted = await pageOf(contract, { total: '1' })
          expect(counted.total).toEqual({ count: 1000, capped: true })
        })
      })
    }
  })
}
