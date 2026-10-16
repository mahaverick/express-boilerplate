/**
 * @file The shared list contract suite. `describeListContract` runs, for one
 * list endpoint: the first page, next, prev back to the first page, every
 * sort read in pages and in one read (both ways) and checked against the
 * real order of its key (monotonic, ids breaking ties, the seed varied
 * enough to prove it), the default sort, search, multi-value filters, the
 * exact total and the capped total, and the 400s (unknown sort, `prev`
 * with no cursor, a tampered, oversize or empty cursor, and a cursor
 * reused under another sort, search or filter, each the one
 * `CURSOR_INVALID` body). A list describes its rows through a
 * `ListContract`; `seed` inserts them in one statement and must give every
 * sort key at least two distinct values and one tie, or the suite fails.
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
   * The describe title, e.g. `GET /api/v1/platform/tenants`.
   */
  name: string
  /**
   * The app under test.
   */
  app: () => RequestListener
  /**
   * The list's URL path, read after `setup` has run.
   */
  path: () => string
  /**
   * Headers that authenticate a caller who may read the list.
   */
  headers: () => Record<string, string>
  /**
   * Params that select this contract's rows and nothing else in the worker's database; merged into every request.
   */
  isolate: () => Record<string, string>
  /**
   * Every whitelisted sort key, the default first.
   */
  sorts: readonly [string, ...string[]]
  /**
   * One key function per entry of `sorts`, reading the sorted value as the response shows it (a computed key, like a role rank or `lastSignIn ?? -Infinity`, comes from the endpoint). A leading `-` on the sort means the keys must fall; ids break ties in the same direction.
   */
  order: Readonly<Record<string, (item: unknown) => string | number>>
  /**
   * The sort a request without `sort` uses, given the request's filter query; `sorts[0]` when absent.
   */
  defaultSort?: (filters: Record<string, string>) => string
  /**
   * Sorts whose key values are unique across the seed (a flag's `key`): they skip the tie requirement and still need at least 2 distinct values.
   */
  uniqueKeys?: readonly string[]
  /**
   * Creates what every case needs (a caller, a tenant), once.
   */
  setup: () => Promise<void>
  /**
   * Inserts `count` rows that `isolate` selects, in one statement.
   * Time sorts need distinct `created_at` offsets with at least one repeat; text sorts must seed values that differ in alphanumerics, because the database collation and the suite's code-unit compare disagree on punctuation.
   */
  seed: (count: number) => Promise<void>
  /**
   * Deletes every row `seed` inserted.
   */
  clear: () => Promise<void>
  /**
   * Deletes what `setup` created.
   */
  teardown: () => Promise<void>
  /**
   * An item's id, for comparing pages; `item.id` when absent.
   */
  idOf?: (item: unknown) => string
  /**
   * Rows `isolate` selects after `seed(5)`, when not 5: the caller's own membership adds one; the fixed flags registry has two.
   */
  visible?: number
  /**
   * The page size the paging tests use; 2 unless the list holds too few rows for three pages.
   */
  pageSize?: number
  /**
   * A search, isolated like every request, that selects exactly `count` rows after `seed(5)`.
   */
  search: { text: string; count: number }
  /**
   * Filter queries, each with the number of rows it selects after `seed(5)`; one per filter, a comma list where the filter takes one. The first must select a view other than the endpoint's default, or the cursor replay under it would hash the same and be accepted.
   */
  filters?: readonly { query: Record<string, string>; count: number }[]
  /**
   * For a list whose rows depend on something other than its query (a path tenant, the calling user): another path and caller, read after `setup`. A cursor issued to the contract's own caller must be refused there with the one `CURSOR_INVALID` body.
   */
  otherScope?: { path: () => string; headers: () => Record<string, string> }
  /**
   * False when the list cannot hold 1001 isolated rows (the fixed flags registry).
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
 * The sort a request without `sort` gets, given the filters it carries on
 * top of the contract's isolation.
 * @param contract - The list.
 * @param query - The request's filter params.
 * @returns The default sort.
 */
function defaultFor(contract: ListContract, query: Record<string, string>): string {
  return contract.defaultSort?.({ ...contract.isolate(), ...query }) ?? contract.sorts[0]
}

/**
 * Compare two sort keys.
 * @param left - One key.
 * @param right - The other.
 * @returns Negative when `left` is smaller, positive when larger, 0 when equal.
 */
function compare(left: string | number, right: string | number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Assert that a page's items read in the real order of the sort's key: the
 * keys never move against the sort's direction, and rows with equal keys
 * have ids in the same direction.
 * @param contract - The list.
 * @param sort - The sort the items were read under.
 * @param items - The items, in the order the server returned them.
 */
function expectOrdered(contract: ListContract, sort: string, items: readonly unknown[]): void {
  const key = contract.order[sort]
  if (key === undefined) throw new Error(`the contract has no order key for sort ${sort}`)
  const sign = sort.startsWith('-') ? -1 : 1
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1]
    const after = items[index]
    const byKey = sign * compare(key(before), key(after))
    const byId = sign * compare(idOf(contract, before), idOf(contract, after))
    expect(
      byKey,
      `sort=${sort}: ${String(key(before))} before ${String(key(after))}`
    ).toBeLessThanOrEqual(0)
    if (byKey === 0) {
      expect(byId, `sort=${sort}: ids of equal keys ${String(key(before))}`).toBeLessThan(0)
    }
  }
}

/**
 * Assert the seed varies the sort's key enough for `expectOrdered` to bite:
 * at least two distinct values and at least one tie.
 * @param contract - The list.
 * @param sort - The sort.
 * @param items - The whole list read under that sort.
 */
function expectVariedSeed(contract: ListContract, sort: string, items: readonly unknown[]): void {
  const key = contract.order[sort]
  if (key === undefined) throw new Error(`the contract has no order key for sort ${sort}`)
  const keys = items.map((item) => key(item))
  const distinct = new Set(keys).size
  expect(
    distinct,
    `sort=${sort}: the seed gives the key fewer than 2 distinct values`
  ).toBeGreaterThan(1)
  if (contract.uniqueKeys?.includes(sort) !== true) {
    expect(distinct, `sort=${sort}: the seed gives the key no tie`).toBeLessThan(keys.length)
  }
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

      const wholes = new Map<string, string[]>()

      it.each(contract.sorts)(
        'sort=%s reads every row once, in order, in pages either way',
        async (sort) => {
          const whole = await pageOf(contract, { sort, limit: '100' })
          const ids = whole.items.map((item) => idOf(contract, item))
          wholes.set(sort, ids)
          expect(ids).toHaveLength(visible)
          expect(new Set(ids).size).toBe(visible)
          expectVariedSeed(contract, sort, whole.items)
          expectOrdered(contract, sort, whole.items)
          const { forward, backward } = await walk(contract, { sort })
          expect(forward).toEqual(ids)
          expect(backward).toEqual(ids)
        }
      )

      it('reads a descending sort as the exact reverse of its ascending pair', () => {
        const pairs = contract.sorts.filter((sort) => contract.sorts.includes(`-${sort}`))
        for (const sort of pairs) {
          const up = wholes.get(sort) ?? []
          const down = wholes.get(`-${sort}`) ?? []
          expect(up).toHaveLength(visible)
          expect(down).toEqual(up.toReversed())
        }
      })

      it('reads the default sort when none is given', async () => {
        const defaultSort = defaultFor(contract, {})
        const unsorted = await pageOf(contract, { limit: '100' })
        expectOrdered(contract, defaultSort, unsorted.items)
        expect(unsorted.items.map((item) => idOf(contract, item))).toEqual(wholes.get(defaultSort))
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
          expectOrdered(contract, defaultFor(contract, filter.query), found.items)
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

      let issued: Promise<string> | undefined
      /**
       * A cursor the server issued for the unfiltered, default view; one read per block.
       * @returns The cursor.
       */
      const issuedCursor = async (): Promise<string> => {
        issued ??= (async () => {
          const first = await pageOf(contract, { limit: size })
          return String(first.page.nextCursor)
        })()
        return await issued
      }

      /**
       * Assert a query is refused with the one cursor body.
       * @param query - Params on top of the page size.
       */
      const expectRefused = async (query: Record<string, string>): Promise<void> => {
        const { status, body } = await get(contract, { limit: size, ...query })
        expect(status, JSON.stringify(query)).toBe(400)
        expect(body.code).toBe('CURSOR_INVALID')
        expect(body.errors).toEqual({ cursor: ['cursor is invalid.'] })
      }

      it('refuses a tampered, oversize or empty cursor with one body', async () => {
        const cursor = await issuedCursor()
        for (const query of [
          { cursor: tampered(cursor) },
          { cursor: 'a'.repeat(4097) },
          { cursor: '' },
        ]) {
          await expectRefused(query)
        }
      })

      it('refuses a cursor replayed under another search', async () => {
        await expectRefused({
          cursor: await issuedCursor(),
          search: `${contract.isolate().search ?? ''}zzz`,
        })
      })

      const { otherScope } = contract
      if (otherScope !== undefined) {
        it('refuses a cursor replayed under another path or caller', async () => {
          const response = await request(contract.app())
            .get(otherScope.path())
            .query({ ...contract.isolate(), limit: size, cursor: await issuedCursor() })
            .set(otherScope.headers())
          const body = response.body as Envelope
          expect(response.status).toBe(400)
          expect(body.code).toBe('CURSOR_INVALID')
          expect(body.errors).toEqual({ cursor: ['cursor is invalid.'] })
        })
      }

      const otherSort = contract.sorts.find((sort) => sort !== defaultFor(contract, {}))
      if (otherSort === undefined) {
        // eslint-disable-next-line sonarjs/assertions-in-tests -- a skip that names why this list has nothing to replay
        it.skip('refuses a cursor replayed under another sort (the list has one sort)', () => {})
      } else {
        it('refuses a cursor replayed under another sort', async () => {
          await expectRefused({ cursor: await issuedCursor(), sort: otherSort })
        })
      }

      const otherFilter = contract.filters?.[0]?.query
      if (otherFilter === undefined) {
        // eslint-disable-next-line sonarjs/assertions-in-tests -- a skip that names why this list has nothing to replay
        it.skip('refuses a cursor replayed under another filter (the list has no filters)', () => {})
      } else {
        it('refuses a cursor replayed under another filter', async () => {
          await expectRefused({ cursor: await issuedCursor(), ...otherFilter })
        })
      }
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
