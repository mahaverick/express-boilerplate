/**
 * @file The list helper without a database: the seek builder for uniform
 * and mixed directions and for `prev`, the page query's order and limit,
 * the search predicate's escaping, the capped total, and
 * `listPageInMemory`'s whole paging contract.
 */
import { and, eq, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tenantModel } from '@/database/models/tenant.model'
import { InvalidCursorError } from '@/errors/list-errors'
import { db } from '@/services/database.service'
import { bindScope, signCursor } from '@/utilities/list-cursor.utilities'
import {
  cappedTotal,
  defineList,
  LIST_TOTAL_CAP,
  listPageInMemory,
  listPageQuery,
  searchCondition,
  seekCondition,
  textSort,
  timestampKey,
  timestampSort,
  type InMemoryListDefinition,
  type SeekColumn,
} from '@/utilities/list-page.utilities'
import { listFilter, listParamsSchema } from '@/validators/list.validators'

const dialect = new PgDialect()
const ID = '0199c4a2-0000-7000-8000-000000000001'
// eslint-disable-next-line unicorn/no-null -- the list contract sends JSON null for a missing cursor
const NONE = null

/**
 * A seek column over a bare SQL name, for reading the rendered condition.
 */
function column(name: string, direction: 'asc' | 'desc'): SeekColumn {
  return { expression: sql.raw(name), direction, key: name, value: z.string() }
}

describe('seekCondition', () => {
  it('is one row comparison when every column runs ascending', () => {
    const condition = seekCondition([column('a', 'asc'), column('id', 'asc')], ['x', ID], false)
    expect(dialect.sqlToQuery(condition)).toMatchObject({
      sql: '(a, id) > ($1, $2)',
      params: ['x', ID],
    })
  })

  it('is one row comparison the other way when every column runs descending', () => {
    const condition = seekCondition([column('a', 'desc'), column('id', 'desc')], ['x', ID], false)
    expect(dialect.sqlToQuery(condition).sql).toBe('(a, id) < ($1, $2)')
  })

  it('reverses every comparison for prev', () => {
    const condition = seekCondition([column('a', 'desc'), column('id', 'desc')], ['x', ID], true)
    expect(dialect.sqlToQuery(condition).sql).toBe('(a, id) > ($1, $2)')
  })

  it('expands mixed directions into an OR of equal prefixes', () => {
    const condition = seekCondition(
      [column('a', 'asc'), column('b', 'desc'), column('id', 'asc')],
      ['x', 'y', ID],
      false
    )
    expect(dialect.sqlToQuery(condition)).toMatchObject({
      sql: '((a > $1 or (a = $2 and b < $3) or (a = $4 and b = $5 and id > $6)))',
      params: ['x', 'x', 'y', 'x', 'y', ID],
    })
  })

  it('flips each branch of a mixed expansion for prev', () => {
    const condition = seekCondition(
      [column('a', 'asc'), column('b', 'desc'), column('id', 'asc')],
      ['x', 'y', ID],
      true
    )
    expect(dialect.sqlToQuery(condition).sql).toBe(
      '((a < $1 or (a = $2 and b > $3) or (a = $4 and b = $5 and id < $6)))'
    )
  })

  it('binds a value through the column’s bind', () => {
    const at: SeekColumn = { ...column('t', 'asc'), bind: (value) => sql`${value}::timestamptz` }
    const condition = seekCondition(
      [at, column('id', 'asc')],
      ['2026-01-01T00:00:00.000000Z', ID],
      false
    )
    expect(dialect.sqlToQuery(condition).sql).toBe('(t, id) > ($1::timestamptz, $2)')
  })
})

const tenants = defineList({
  base: (executor, seek) =>
    executor
      .select({
        id: tenantModel.id,
        sortName: sql<string>`lower(${tenantModel.name})`,
        sortCreated: timestampKey(tenantModel.createdAt),
      })
      .from(tenantModel)
      .where(and(eq(tenantModel.isPlatform, false), seek))
      .$dynamic(),
  id: tenantModel.id,
  sorts: {
    name: [textSort(sql`lower(${tenantModel.name})`, 'asc', 'sortName')],
    '-created': [timestampSort(tenantModel.createdAt, 'desc', 'sortCreated')],
  },
  toItem: ({ sortName: _name, sortCreated: _created, ...row }) => row,
})
const tenantSchema = listParamsSchema({
  sorts: ['name', '-created'],
  defaultSort: 'name',
  filters: {},
})

describe('listPageQuery', () => {
  it('orders by the sort then the id and reads one row past the page', () => {
    const query = listPageQuery(db, tenants, tenantSchema.parse({ limit: '2' }).params).toSQL()
    expect(query.sql).toContain('order by lower("tenants"."name") asc, "tenants"."id" asc limit $2')
    expect(query.params).toEqual([false, 3])
  })

  it('reverses the order and seeks after the cursor for prev', () => {
    const scope = tenantSchema.parse({ sort: '-created' }).params.scope
    const cursor = signCursor('-created', scope, ['2026-01-01T00:00:00.000000Z', ID])
    const params = tenantSchema.parse({ sort: '-created', direction: 'prev', cursor }).params
    const query = listPageQuery(db, tenants, params).toSQL()
    expect(query.sql).toContain(
      '("tenants"."created_at", "tenants"."id") > ($2::timestamptz, $3)) order by "tenants"."created_at" asc, "tenants"."id" asc'
    )
  })

  it('refuses a cursor signed for another sort before building anything', () => {
    const scope = tenantSchema.parse({}).params.scope
    const cursor = signCursor('-created', scope, ['2026-01-01T00:00:00.000000Z', ID])
    const params = tenantSchema.parse({ cursor }).params
    expect(() => listPageQuery(db, tenants, params)).toThrow(InvalidCursorError)
  })
})

/**
 * The tenants list bound to one tenant.
 */
function owned(tenantId: string) {
  return { ...tenants, bound: { tenantId } }
}

describe('a list with bound values', () => {
  const params = tenantSchema.parse({}).params

  it('accepts a cursor signed under the same bound value', () => {
    const cursor = signCursor('name', bindScope(params.scope, { tenantId: 'a' }), ['x', ID])
    const withCursor = { ...params, cursor }
    expect(() => listPageQuery(db, owned('a'), withCursor)).not.toThrow()
  })

  it('refuses a cursor signed under another bound value, or under none', () => {
    const other = signCursor('name', bindScope(params.scope, { tenantId: 'b' }), ['x', ID])
    const unbound = signCursor('name', params.scope, ['x', ID])
    for (const cursor of [other, unbound]) {
      expect(() => listPageQuery(db, owned('a'), { ...params, cursor })).toThrow(InvalidCursorError)
    }
  })

  it('leaves a list without bound values on the plain scope', () => {
    const cursor = signCursor('name', params.scope, ['x', ID])
    expect(() => listPageQuery(db, tenants, { ...params, cursor })).not.toThrow()
    const bound = signCursor('name', bindScope(params.scope, { tenantId: 'a' }), ['x', ID])
    expect(() => listPageQuery(db, tenants, { ...params, cursor: bound })).toThrow(
      InvalidCursorError
    )
  })
})

/**
 * The in-memory test list bound to `list`.
 * @param list - The bound value.
 * @returns The definition.
 */
function boundTo(list: string): InMemoryListDefinition<Row, string> {
  return { ...memory, bound: { list } }
}

describe('an in-memory list with bound values', () => {
  const params = memorySchema.parse({ limit: '2' }).params

  it('accepts a cursor issued under the same bound value', () => {
    const first = listPageInMemory(rows, boundTo('a'), params)
    const next = { ...params, cursor: String(first.page.nextCursor) }
    expect(listPageInMemory(rows, boundTo('a'), next).items).toEqual(['k2', 'k3'])
  })

  it('refuses a cursor issued under another bound value, or under none', () => {
    const fromA = String(listPageInMemory(rows, boundTo('a'), params).page.nextCursor)
    const unbound = String(listPageInMemory(rows, memory, params).page.nextCursor)
    expect(() => listPageInMemory(rows, boundTo('b'), { ...params, cursor: fromA })).toThrow(
      InvalidCursorError
    )
    expect(() => listPageInMemory(rows, boundTo('a'), { ...params, cursor: unbound })).toThrow(
      InvalidCursorError
    )
  })

  it('leaves a list without bound values on the plain scope', () => {
    const cursor = signCursor('key', params.scope, ['k1'])
    expect(listPageInMemory(rows, memory, { ...params, cursor }).items).toEqual(['k2', 'k3'])
    const boundCursor = signCursor('key', bindScope(params.scope, { list: 'a' }), ['k1'])
    expect(() => listPageInMemory(rows, memory, { ...params, cursor: boundCursor })).toThrow(
      InvalidCursorError
    )
  })
})

describe('searchCondition', () => {
  it('matches each expression as a literal substring, wildcards escaped', () => {
    const condition = searchCondition('50%_\\', [sql.raw('lower(name)'), sql.raw('slug')])
    expect(condition && dialect.sqlToQuery(condition)).toEqual({
      sql: String.raw`((lower(name) like lower($1) escape '\' or slug like lower($2) escape '\'))`,
      params: [String.raw`%50\%\_\\%`, String.raw`%50\%\_\\%`],
      typings: ['none', 'none'],
    })
  })

  it('is no condition without a search', () => {
    expect(searchCondition(undefined, [sql.raw('lower(name)')])).toBeUndefined()
  })
})

describe('cappedTotal', () => {
  it('is exact up to the cap and capped past it', () => {
    expect(cappedTotal(LIST_TOTAL_CAP)).toEqual({ count: 1000, capped: false })
    expect(cappedTotal(LIST_TOTAL_CAP + 1)).toEqual({ count: 1000, capped: true })
  })
})

/**
 * One in-memory row.
 */
interface Row {
  key: string
  rank: number
  kind: 'a' | 'b'
}

const rows: Row[] = Array.from({ length: 5 }, (_unused, index) => ({
  key: `k${index}`,
  rank: index % 2,
  kind: index % 2 === 0 ? 'a' : 'b',
}))

const memory: InMemoryListDefinition<Row, string> = {
  id: (row) => row.key,
  idValue: z.string(),
  sorts: {
    key: [],
    '-key': [{ direction: 'desc', of: (row) => row.key, value: z.string() }],
    rank: [{ direction: 'asc', of: (row) => row.rank, value: z.number() }],
  },
  toItem: (row) => row.key,
}
const memorySchema = listParamsSchema({
  sorts: ['key', '-key', 'rank'],
  defaultSort: 'key',
  filters: { kind: listFilter('kind', ['a', 'b']).optional() },
})

/**
 * One in-memory page for a raw query.
 */
function page(query: Record<string, string>, source: readonly Row[] = rows) {
  return listPageInMemory(source, memory, memorySchema.parse({ limit: '2', ...query }).params)
}

describe('listPageInMemory', () => {
  it('pages forward, then back to the first page', () => {
    const first = page({ total: '1' })
    expect(first).toMatchObject({
      items: ['k0', 'k1'],
      page: { hasNext: true, hasPrev: false, prevCursor: NONE, limit: 2 },
      total: { count: 5, capped: false },
    })
    const second = page({ cursor: String(first.page.nextCursor) })
    expect(second.items).toEqual(['k2', 'k3'])
    expect(second.page).toMatchObject({ hasNext: true, hasPrev: true })
    expect(second.total).toBeUndefined()
    const third = page({ cursor: String(second.page.nextCursor) })
    expect(third).toMatchObject({ items: ['k4'], page: { hasNext: false, nextCursor: NONE } })
    const backToSecond = page({ cursor: String(third.page.prevCursor), direction: 'prev' })
    expect(backToSecond.items).toEqual(['k2', 'k3'])
    const backToFirst = page({ cursor: String(backToSecond.page.prevCursor), direction: 'prev' })
    expect(backToFirst).toMatchObject({
      items: ['k0', 'k1'],
      page: { hasPrev: false, prevCursor: NONE, hasNext: true },
    })
  })

  it('reads the first page when a prev page from a cursor is empty', () => {
    // The first page's next cursor points at k0, the first row: nothing lies before it.
    const cursor = String(page({ limit: '1' }).page.nextCursor)
    expect(page({ limit: '1', cursor, direction: 'prev' })).toMatchObject({
      items: ['k0'],
      page: { hasNext: true, hasPrev: false, prevCursor: NONE },
    })
  })

  it('reads the last page when a next page from a cursor is empty', () => {
    const cursor = String(page({ limit: '1' }).page.nextCursor)
    const shrunk = rows.slice(0, 1)
    expect(page({ limit: '1', cursor }, shrunk)).toMatchObject({
      items: ['k0'],
      page: { hasNext: false, hasPrev: false },
    })
  })

  it('continues forward from a first page read after the rows before the cursor are deleted', () => {
    const second = page({ cursor: String(page({}).page.nextCursor) })
    const remaining = rows.slice(2)
    const first = page({ direction: 'prev', cursor: String(second.page.prevCursor) }, remaining)
    expect(first.items).toEqual(['k2', 'k3'])
    expect(first.page).toMatchObject({ hasPrev: false, hasNext: true, prevCursor: NONE })
    const next = page({ cursor: String(first.page.nextCursor) }, remaining)
    expect(next.items).toEqual(['k4'])
    expect(next.page).toMatchObject({ hasPrev: true, hasNext: false, nextCursor: NONE })
  })

  it('continues backward from a last page read after the rows after the cursor are deleted', () => {
    const second = page({ cursor: String(page({}).page.nextCursor) })
    const remaining = rows.slice(0, 4)
    const last = page({ cursor: String(second.page.nextCursor) }, remaining)
    expect(last.items).toEqual(['k2', 'k3'])
    expect(last.page).toMatchObject({ hasNext: false, hasPrev: true, nextCursor: NONE })
    const before = page({ direction: 'prev', cursor: String(last.page.prevCursor) }, remaining)
    expect(before.items).toEqual(['k0', 'k1'])
    expect(before.page).toMatchObject({ hasPrev: false, hasNext: true })
  })

  it('sorts descending, and breaks ties on the id in the first column’s direction', () => {
    expect(page({ sort: '-key', limit: '5' }).items).toEqual(['k4', 'k3', 'k2', 'k1', 'k0'])
    expect(page({ sort: 'rank', limit: '5' }).items).toEqual(['k0', 'k2', 'k4', 'k1', 'k3'])
  })

  it('pages across a tie without skipping or repeating a row', () => {
    const seen: string[] = []
    let cursor: string | null | undefined
    do {
      const next = page({ sort: 'rank', ...(typeof cursor === 'string' && { cursor }) })
      seen.push(...next.items)
      cursor = next.page.nextCursor
    } while (typeof cursor === 'string')
    expect(seen).toEqual(['k0', 'k2', 'k4', 'k1', 'k3'])
  })

  it('caps the total at 1000', () => {
    const many = Array.from({ length: 1001 }, (_unused, index) => ({
      key: `m${String(index).padStart(4, '0')}`,
      rank: 0,
      kind: 'a' as const,
    }))
    expect(page({ total: '1' }, many).total).toEqual({ count: 1000, capped: true })
  })

  it('refuses a cursor from another sort or filter', () => {
    const cursor = String(page({}).page.nextCursor)
    expect(() => page({ sort: '-key', cursor })).toThrow(InvalidCursorError)
    expect(() => page({ kind: 'a', cursor })).toThrow(InvalidCursorError)
  })

  it('refuses an empty cursor with the same error, whichever the direction', () => {
    expect(() => page({ cursor: '' })).toThrow(InvalidCursorError)
    expect(() => page({ cursor: '', direction: 'prev' })).toThrow(InvalidCursorError)
  })
})
