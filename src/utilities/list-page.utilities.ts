/**
 * @file The one list helper: keyset pages in both directions over any
 * drizzle select, whitelisted sorts, and a total counted up to a cap. Every
 * sort column is NOT NULL (or coalesced the same way in its index) and the
 * row id is appended as the tiebreaker, so a page boundary never skips or
 * repeats a row. `listPageInMemory` gives the same contract over an array.
 */
import { and, asc, desc, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn, PgSelect } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { InvalidCursorError } from '@/errors/list-errors'
import type { DbExecutor } from '@/services/database.service'
import { escapeLikePattern } from '@/utilities/like-pattern.utilities'
import {
  bindScope,
  signCursor,
  verifyCursor,
  type CursorKey,
} from '@/utilities/list-cursor.utilities'
import { sortAtField } from '@/validators/cursor.validators'

/**
 * The most rows a total counts exactly; past it the total reads `{ count: 1000, capped: true }`.
 */
export const LIST_TOTAL_CAP = 1000

/**
 * The order one sort column runs in.
 */
export type SortDirection = 'asc' | 'desc'

/**
 * Which way a page moves from its cursor.
 */
type ListDirection = 'next' | 'prev'

/**
 * One column of a whitelisted sort.
 */
export interface SortDef {
  /**
  Column or SQL expression; must be NOT NULL (or coalesced) and indexed.
   */
  expression: AnyPgColumn | SQL
  direction: SortDirection
  /**
  The selected row property that holds this column's cursor value, as text or a number.
   */
  key: string
  /**
  The cursor value's schema, checked when the cursor comes back.
   */
  value: z.ZodType<CursorKey>
  /**
  How a cursor value is bound into the seek; a plain parameter when absent.
   */
  bind?: (value: CursorKey) => SQL
}

/**
 * The parsed shared params of one list request, with its scope hash.
 */
export interface ListParams {
  search: string | undefined
  sort: string
  cursor: string | undefined
  direction: ListDirection
  limit: number
  total: boolean
  scope: string
}

/**
 * Where a page sits: its cursors, whether rows lie either side, and its size.
 */
interface ListPageInfo {
  nextCursor: string | null
  prevCursor: string | null
  hasNext: boolean
  hasPrev: boolean
  limit: number
}

/**
 * One page of a list, as every list endpoint returns it in `data`.
 */
export interface ListPage<T> {
  items: T[]
  page: ListPageInfo
  /**
  Present only when the request sent `total=1`.
   */
  total?: { count: number; capped: boolean }
}

/**
 * One list over the database.
 */
export interface ListDefinition<TQuery extends PgSelect, Item> {
  /**
  The list's own name, unique among lists; folded into the scope so a cursor from one list is refused by another that shares its sort and filters.
   */
  name: string
  /**
  select + joins + filters + search predicate, ANDed with `seek`, without order or limit; ends in `.$dynamic()`.
   */
  base: (executor: DbExecutor, seek: SQL | undefined) => TQuery
  id: AnyPgColumn | SQL
  /**
  The selected row property holding the id; `id` when absent.
   */
  idKey?: string
  /**
  The id's cursor schema; a uuid when absent.
   */
  idValue?: z.ZodType<CursorKey>
  /**
  Sort key (with its leading `-` when descending) to its ordered columns; the helper appends the id.
   */
  sorts: Readonly<Record<string, readonly SortDef[]>>
  /**
  Values that define the list without being query params (a path tenant, the calling user); folded into the scope with the name, so a cursor minted under one value is refused under another. Absent for a list with none.
   */
  bound?: Readonly<Record<string, string>>
  toItem: (row: ListRow<TQuery>) => Item
}

/**
 * One row a list's base query returns.
 */
type ListRow<TQuery> = Awaited<TQuery> extends readonly (infer Row)[] ? Row : never

/**
 * A sort column with the id appended, as the seek and the order use it.
 */
export interface SeekColumn {
  expression: AnyPgColumn | SQL
  direction: SortDirection
  key: string
  value: z.ZodType<CursorKey>
  bind?: ((value: CursorKey) => SQL) | undefined
}

/**
 * The columns of `sort`, the id appended in the first column's direction
 * (ascending when the sort has none).
 * @param sorts - The list's whitelist.
 * @param sort - The request's sort key, already validated against it.
 * @param id - The id column, its row property and its cursor schema.
 * @returns The seek columns.
 * @throws {Error} When `sort` is not whitelisted: the request schema should have refused it.
 */
function seekColumnsOf(
  sorts: Readonly<Record<string, readonly SortDef[]>>,
  sort: string,
  id: Pick<SeekColumn, 'expression' | 'key' | 'value'>
): SeekColumn[] {
  const columns = sorts[sort]
  if (columns === undefined) throw new Error(`sort ${sort} is not whitelisted`)
  return [...columns, { ...id, direction: columns[0]?.direction ?? 'asc' }]
}

/**
 * The direction a column is read in: its own for `next`, the reverse for `prev`.
 * @param column - The column.
 * @param isPrevious - Whether the page reads backwards.
 * @returns The read direction.
 */
function readDirection(column: SeekColumn, isPrevious: boolean): SortDirection {
  if (!isPrevious) return column.direction
  return column.direction === 'asc' ? 'desc' : 'asc'
}

/**
 * A cursor value bound for comparison with its column.
 * @param column - The column.
 * @param value - The cursor's value for it.
 * @returns The bound value.
 */
function boundValue(column: SeekColumn, value: CursorKey): SQL {
  return column.bind === undefined ? sql`${value}` : column.bind(value)
}

/**
 * The seek condition: the rows after the cursor in read order. A row
 * comparison when every column reads one way; otherwise the OR-expansion
 * `(a > x) or (a = x and b < y) or (a = x and b = y and c > z)`.
 * @param columns - The seek columns, id last.
 * @param keys - The cursor's keys, one per column.
 * @param isPrevious - Whether the page reads backwards.
 * @returns The condition.
 */
export function seekCondition(
  columns: readonly SeekColumn[],
  keys: readonly CursorKey[],
  isPrevious: boolean
): SQL {
  const pairs = columns.map((column, index) => {
    const key = keys[index]
    if (key === undefined) throw new Error('a cursor key is missing')
    return {
      expression: column.expression,
      value: boundValue(column, key),
      operator: readDirection(column, isPrevious) === 'asc' ? sql.raw('>') : sql.raw('<'),
    }
  })
  const directions = new Set(columns.map((column) => readDirection(column, isPrevious)))
  if (directions.size === 1) {
    const operator = pairs[0]?.operator ?? sql.raw('>')
    const left = sql.join(
      pairs.map((pair) => sql`${pair.expression}`),
      sql.raw(', ')
    )
    const right = sql.join(
      pairs.map((pair) => pair.value),
      sql.raw(', ')
    )
    return sql`(${left}) ${operator} (${right})`
  }
  const branches = pairs.map((pair, index) =>
    and(
      ...pairs.slice(0, index).map((before) => sql`${before.expression} = ${before.value}`),
      sql`${pair.expression} ${pair.operator} ${pair.value}`
    )
  )
  const condition = or(...branches)
  if (condition === undefined) throw new Error('a sort has no columns')
  return sql`(${condition})`
}

/**
 * Everything a page read needs once the request is checked.
 */
interface PreparedPage {
  columns: SeekColumn[]
  keys: CursorKey[] | undefined
  isPrevious: boolean
}

/**
 * Check the request's cursor against its sort and scope.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The seek columns, the cursor's keys and the read direction.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
function prepare<TQuery extends PgSelect, Item>(
  definition: ListDefinition<TQuery, Item>,
  params: ListParams
): PreparedPage {
  const columns = seekColumnsOf(definition.sorts, params.sort, {
    expression: definition.id,
    key: definition.idKey ?? 'id',
    value: definition.idValue ?? z.uuid(),
  })
  const keys =
    params.cursor === undefined
      ? undefined
      : verifyCursor(params.cursor, {
          sort: params.sort,
          scope: params.scope,
          keys: columns.map((column) => column.value),
        })
  return { columns, keys, isPrevious: params.direction === 'prev' }
}

/**
 * The query one page reads: the base, the seek, the order (reversed for
 * `prev`) and `limit + 1` rows. Exported for the index tests, which EXPLAIN it.
 * @param executor - Where the query will run.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The query, not yet run.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export function listPageQuery<TQuery extends PgSelect, Item>(
  executor: DbExecutor,
  definition: ListDefinition<TQuery, Item>,
  params: ListParams
): TQuery {
  const scoped = scopedParams(definition, params)
  return queryFor(executor, definition, scoped, prepare(definition, scoped))
}

/**
 * The request with its scope narrowed to the list's name and bound values.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The request cursors are signed and checked against.
 */
function scopedParams<TQuery extends PgSelect, Item>(
  definition: ListDefinition<TQuery, Item>,
  params: ListParams
): ListParams {
  return {
    ...params,
    scope: bindScope(bindScope(params.scope, { name: definition.name }), definition.bound ?? {}),
  }
}

/**
 * The page query for an already prepared request.
 * @param executor - Where the query will run.
 * @param definition - The list.
 * @param params - The parsed request.
 * @param prepared - The seek columns, keys and read direction.
 * @returns The query, not yet run.
 */
function queryFor<TQuery extends PgSelect, Item>(
  executor: DbExecutor,
  definition: ListDefinition<TQuery, Item>,
  params: ListParams,
  prepared: PreparedPage
): TQuery {
  const seek =
    prepared.keys === undefined
      ? undefined
      : seekCondition(prepared.columns, prepared.keys, prepared.isPrevious)
  const order = prepared.columns.map((column) =>
    readDirection(column, prepared.isPrevious) === 'asc'
      ? asc(column.expression)
      : desc(column.expression)
  )
  return definition
    .base(executor, seek)
    .orderBy(...order)
    .limit(params.limit + 1)
}

/**
 * A row's cursor keys, read from the properties its seek columns name.
 * @param row - A selected row.
 * @param columns - The seek columns.
 * @returns The keys.
 * @throws {Error} When a property is missing or not text or a number: the base query must select it so.
 */
function keysOf(row: unknown, columns: readonly SeekColumn[]): CursorKey[] {
  const record = row as Record<string, unknown>
  return columns.map((column) => {
    const value = record[column.key]
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`list row property ${column.key} is not text or a number`)
    }
    return value
  })
}

/**
 * Inputs to `toListPage`: the rows in read order, up to `limit + 1`.
 */
interface PageAssembly<Row, Item> {
  rows: Row[]
  params: ListParams
  hadCursor: boolean
  isPrevious: boolean
  keysOf: (row: Row) => CursorKey[]
  toItem: (row: Row) => Item
}

/**
 * A page's cursor on a side with no rows to read.
 */
// eslint-disable-next-line unicorn/no-null -- the list contract sends JSON null for a missing cursor
const NO_CURSOR = null

/**
 * Trim the look-ahead row, put a backwards page back in display order, and
 * set both cursors. A side with no rows beyond the page has no cursor.
 * @param assembly - The rows and how to read them.
 * @returns The page, without its total.
 */
function toListPage<Row, Item>(assembly: PageAssembly<Row, Item>): ListPage<Item> {
  const { params, isPrevious } = assembly
  const rows = assembly.rows.slice(0, params.limit)
  const hasMore = assembly.rows.length > params.limit
  if (isPrevious) rows.reverse()
  const first = rows.at(0)
  const last = rows.at(-1)
  const hasNext = isPrevious ? assembly.hadCursor : hasMore
  const hasPrevious = isPrevious ? hasMore : assembly.hadCursor
  /**
   * The cursor at a boundary row, none for an empty page.
   */
  const cursorAt = (row: Row | undefined): string | null =>
    row === undefined ? NO_CURSOR : signCursor(params.sort, params.scope, assembly.keysOf(row))
  return {
    items: rows.map((row) => assembly.toItem(row)),
    page: {
      nextCursor: hasNext ? cursorAt(last) : NO_CURSOR,
      prevCursor: hasPrevious ? cursorAt(first) : NO_CURSOR,
      hasNext,
      hasPrev: hasPrevious,
      limit: params.limit,
    },
  }
}

/**
 * A count as the total reports it: exact up to the cap, else the cap and `capped`.
 * @param count - Rows counted, at most `LIST_TOTAL_CAP + 1`.
 * @returns The total.
 */
export function cappedTotal(count: number): { count: number; capped: boolean } {
  return count > LIST_TOTAL_CAP ? { count: LIST_TOTAL_CAP, capped: true } : { count, capped: false }
}

/**
 * The request for the edge page a cursor read falls back to when it finds
 * no rows: no cursor, and the direction flipped, so an empty `prev` reads
 * the first page and an empty `next` reads the last.
 * @param params - The request whose cursor read came back empty.
 * @returns The request for the edge page.
 */
function edgeRequest(params: ListParams): ListParams {
  return { ...params, cursor: undefined, direction: params.direction === 'prev' ? 'next' : 'prev' }
}

/**
 * One page read from the request's own cursor.
 * @param executor - Where to run the query.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The page without its total, or undefined when a cursor read finds no rows.
 */
async function readPage<TQuery extends PgSelect, Item>(
  executor: DbExecutor,
  definition: ListDefinition<TQuery, Item>,
  params: ListParams
): Promise<ListPage<Item> | undefined> {
  const prepared = prepare(definition, params)
  const rows = (await queryFor(executor, definition, params, prepared)) as ListRow<TQuery>[]
  if (rows.length === 0 && prepared.keys !== undefined) return undefined
  return toListPage({
    rows,
    params,
    hadCursor: prepared.keys !== undefined,
    isPrevious: prepared.isPrevious,
    keysOf: (row) => keysOf(row, prepared.columns),
    toItem: definition.toItem,
  })
}

/**
 * One page of a list over the database, and its capped total when asked for.
 * A page read from a cursor that finds no rows (the rows around it were
 * deleted) is replaced by the edge page on that side, so no row the cursor
 * stood beside is skipped or repeated.
 * @param executor - Where to run the queries.
 * @param definition - The list.
 * @param requested - The parsed request.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listPage<TQuery extends PgSelect, Item>(
  executor: DbExecutor,
  definition: ListDefinition<TQuery, Item>,
  requested: ListParams
): Promise<ListPage<Item>> {
  const params = scopedParams(definition, requested)
  const read = await readPage(executor, definition, params)
  const page = read ?? (await readPage(executor, definition, edgeRequest(params)))
  if (page === undefined) throw new Error('an edge page read has no cursor to find empty')
  if (!params.total) return page
  const counted = definition.base(executor, undefined).limit(LIST_TOTAL_CAP + 1)
  const [row] = await executor.execute<{ count: number }>(
    sql`select count(*)::int as count from (${counted}) as counted`
  )
  return { ...page, total: cappedTotal(row?.count ?? 0) }
}

/**
 * One column of an in-memory sort.
 */
interface InMemorySortDef<Row> {
  direction: SortDirection
  /**
  The row's value for this column.
   */
  of: (row: Row) => CursorKey
  value: z.ZodType<CursorKey>
}

/**
 * One list over an array.
 */
export interface InMemoryListDefinition<Row, Item> {
  /**
   * The list's own name, unique among lists; folded into the scope as the SQL lists do.
   */
  name: string
  id: (row: Row) => string
  idValue: z.ZodType<CursorKey>
  sorts: Readonly<Record<string, readonly InMemorySortDef<Row>[]>>
  toItem: (row: Row) => Item
  /**
   * Values the list's cursors are bound to, folded into the scope with the name; none when absent.
   */
  bound?: Readonly<Record<string, string>>
}

/**
 * Compare two key tuples column by column in each column's read direction.
 * @param left - One row's keys.
 * @param right - The other's.
 * @param directions - Each column's read direction.
 * @returns Negative when `left` reads first, positive when `right` does, 0 when equal.
 */
function compareKeys(
  left: readonly CursorKey[],
  right: readonly CursorKey[],
  directions: readonly SortDirection[]
): number {
  for (const [index, direction] of directions.entries()) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined || a === b) continue
    const order = a < b ? -1 : 1
    return direction === 'asc' ? order : -order
  }
  return 0
}

/**
 * One page of an array read from the request's own cursor.
 * @param rows - Every row that matches the request's search and filters.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The page without its total, or undefined when a cursor read finds no rows.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
function readMemoryPage<Row, Item>(
  rows: readonly Row[],
  definition: InMemoryListDefinition<Row, Item>,
  params: ListParams
): ListPage<Item> | undefined {
  const sortColumns = definition.sorts[params.sort]
  if (sortColumns === undefined) throw new Error(`sort ${params.sort} is not whitelisted`)
  const columns = [
    ...sortColumns,
    { direction: sortColumns[0]?.direction ?? 'asc', of: definition.id, value: definition.idValue },
  ]
  const isPrevious = params.direction === 'prev'
  const directions = columns.map((column) =>
    isPrevious === (column.direction === 'asc') ? 'desc' : 'asc'
  ) satisfies SortDirection[]
  /**
   * A row's keys, one per column.
   */
  const keysOfRow = (row: Row): CursorKey[] => columns.map((column) => column.of(row))
  const keys =
    params.cursor === undefined
      ? undefined
      : verifyCursor(params.cursor, {
          sort: params.sort,
          scope: params.scope,
          keys: columns.map((column) => column.value),
        })
  const ordered = rows
    .map((row) => ({ row, keys: keysOfRow(row) }))
    .toSorted((a, b) => compareKeys(a.keys, b.keys, directions))
    .filter((entry) => keys === undefined || compareKeys(entry.keys, keys, directions) > 0)
  if (keys !== undefined && ordered.length === 0) return undefined
  return toListPage({
    rows: ordered.slice(0, params.limit + 1).map((entry) => entry.row),
    params,
    hadCursor: keys !== undefined,
    isPrevious,
    keysOf: keysOfRow,
    toItem: definition.toItem,
  })
}

/**
 * One page of an already filtered and searched array, with the same
 * contract, cursor and total as `listPage`, including the edge page an
 * empty cursor read falls back to.
 * @param rows - Every row that matches the request's search and filters.
 * @param definition - The list.
 * @param params - The parsed request.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export function listPageInMemory<Row, Item>(
  rows: readonly Row[],
  definition: InMemoryListDefinition<Row, Item>,
  params: ListParams
): ListPage<Item> {
  const scoped = {
    ...params,
    scope: bindScope(bindScope(params.scope, { name: definition.name }), definition.bound ?? {}),
  }
  const page =
    readMemoryPage(rows, definition, scoped) ??
    readMemoryPage(rows, definition, edgeRequest(scoped))
  if (page === undefined) throw new Error('an edge page read has no cursor to find empty')
  return params.total ? { ...page, total: cappedTotal(rows.length) } : page
}

/**
 * A text sort column: `expression` ascending or descending, its cursor
 * value read from the row property `key`.
 * @param expression - A NOT NULL text expression, selected as `key`.
 * @param direction - The column's direction.
 * @param key - The row property.
 * @returns The column.
 */
export function textSort(
  expression: AnyPgColumn | SQL,
  direction: SortDirection,
  key: string
): SortDef {
  return {
    expression,
    direction,
    key,
    value: z
      .string()
      .max(1024)
      .refine(
        (text) => !text.includes('\0'),
        'cursor text must not contain a null character (U+0000).'
      ),
  }
}

/**
 * A `timestamptz` expression as the UTC text with microseconds a cursor carries.
 * @param expression - The timestamp.
 * @returns The text expression, to select as the sort column's `key`.
 */
export function timestampKey(expression: AnyPgColumn | SQL): SQL<string> {
  return sql<string>`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * A timestamp sort column, its cursor value the `timestampKey` text, cast
 * back with `::timestamptz` for the seek.
 * @param expression - A NOT NULL `timestamptz` expression.
 * @param direction - The column's direction.
 * @param key - The row property holding `timestampKey(expression)`.
 * @returns The column.
 */
export function timestampSort(
  expression: AnyPgColumn | SQL,
  direction: SortDirection,
  key: string
): SortDef {
  return {
    expression,
    direction,
    key,
    value: sortAtField,
    bind: (value) => sql`${value}::timestamptz`,
  }
}

/**
 * The search predicate: any of `expressions` contains `search` as a
 * literal, case-insensitive substring. Each expression is already lowered
 * the way its trigram index is built.
 * @param search - The parsed search, or undefined for none.
 * @param expressions - The lowered text expressions to match.
 * @returns The condition, or undefined without a search.
 */
export function searchCondition(
  search: string | undefined,
  expressions: readonly SQL[]
): SQL | undefined {
  if (search === undefined) return undefined
  const pattern = `%${escapeLikePattern(search)}%`
  const matches = or(
    ...expressions.map((expression) => sql`${expression} like lower(${pattern}) escape '\\'`)
  )
  return matches === undefined ? undefined : sql`(${matches})`
}

/**
 * A list definition, returned as given: the call lets TypeScript infer the
 * row type from `base` and check `toItem` against it.
 * @param definition - The list.
 * @returns The same definition.
 */
export function defineList<TQuery extends PgSelect, Item>(
  definition: ListDefinition<TQuery, Item>
): ListDefinition<TQuery, Item> {
  return definition
}
