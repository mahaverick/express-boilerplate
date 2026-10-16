/**
 * @file The shared list contract suite run against a list the test builds
 * itself, an in-memory array behind a two-route Express app, so the suite
 * is proved without a database before any endpoint uses it.
 */
import { randomUUID } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HttpError } from '@/errors/http-error'
import { listPageInMemory, type InMemoryListDefinition } from '@/utilities/list-page.utilities'
import { listFilter, listParamsSchema } from '@/validators/list.validators'
import { parseBody } from '@/validators/parse.validators'
import { describeListContract } from '../../helpers/list-contract'

/**
 * One row of the test list.
 */
interface Thing {
  id: string
  name: string
  kind: 'a' | 'b'
}

// eslint-disable-next-line unicorn/no-null -- the list contract sends JSON null for a missing cursor
const NONE = null
const things: Thing[] = []
const tag = `c${randomUUID().slice(0, 8)}`

const schema = listParamsSchema({
  sorts: ['name', '-name'],
  defaultSort: 'name',
  filters: { kind: listFilter('kind', ['a', 'b']).optional() },
})

const definition: InMemoryListDefinition<Thing, Thing> = {
  id: (thing) => thing.id,
  idValue: z.uuid(),
  sorts: {
    name: [{ direction: 'asc', of: (thing) => thing.name, value: z.string() }],
    '-name': [{ direction: 'desc', of: (thing) => thing.name, value: z.string() }],
  },
  toItem: (thing) => thing,
}

const app = express()
app.disable('x-powered-by')
app.get('/things', (request: Request, response: Response, next: NextFunction) => {
  try {
    const { params, filters } = parseBody(schema, request.query)
    const matching = things.filter(
      (thing) =>
        (params.search === undefined || thing.name.includes(params.search)) &&
        (filters.kind === undefined || filters.kind.includes(thing.kind))
    )
    response.json({ success: true, data: listPageInMemory(matching, definition, params) })
  } catch (error) {
    next(error)
  }
})
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const http = error instanceof HttpError ? error : new HttpError('Internal server error')
  response
    .status(http.statusCode)
    .json({ success: false, message: http.message, code: http.code, errors: http.errors })
})

describeListContract({
  name: 'GET /things',
  app: () => app,
  path: () => '/things',
  headers: () => ({}),
  isolate: () => ({ search: tag }),
  sorts: ['name', '-name'],
  setup: async () => {},
  seed: (count) => {
    for (let index = 0; index < count; index += 1) {
      things.push({
        id: randomUUID(),
        name: `${tag}-${String(index).padStart(4, '0')}`,
        kind: index % 2 === 0 ? 'a' : 'b',
      })
    }
    return Promise.resolve()
  },
  clear: () => {
    things.length = 0
    return Promise.resolve()
  },
  teardown: async () => {},
  search: { text: `${tag}-0003`, count: 1 },
  filters: [
    { query: { kind: 'a' }, count: 3 },
    { query: { kind: 'b,a' }, count: 5 },
  ],
})

/**
 * One page of `rows` read through the same schema and definition the contract uses.
 * @param rows - The rows left in the list.
 * @param query - The request's query.
 * @returns The page.
 */
function readPage(
  rows: Thing[],
  query: Record<string, string>
): ReturnType<typeof listPageInMemory> {
  const { params } = parseBody(schema, query)
  return listPageInMemory(rows, definition, params)
}

describe('an edge page read after the rows behind a cursor are deleted', () => {
  const rows: Thing[] = Array.from({ length: 5 }, (_unused, index) => ({
    id: randomUUID(),
    name: `edge-${String(index)}`,
    kind: 'a',
  }))
  /**
   * The names on a page, in order.
   * @param page - A page of things.
   * @returns Its names.
   */
  const names = (page: ReturnType<typeof readPage>): string[] =>
    page.items.map((item) => (item as Thing).name)

  it('continues forward from a first page that has more rows beyond it', () => {
    const second = readPage(rows, {
      limit: '2',
      cursor: String(readPage(rows, { limit: '2' }).page.nextCursor),
    })
    const remaining = rows.slice(2)
    const first = readPage(remaining, {
      limit: '2',
      direction: 'prev',
      cursor: String(second.page.prevCursor),
    })
    expect(names(first)).toEqual(['edge-2', 'edge-3'])
    expect(first.page).toMatchObject({ hasPrev: false, hasNext: true, prevCursor: NONE })
    const next = readPage(remaining, { limit: '2', cursor: String(first.page.nextCursor) })
    expect(names(next)).toEqual(['edge-4'])
    expect(next.page).toMatchObject({ hasPrev: true, hasNext: false, nextCursor: NONE })
  })

  it('continues backward from a last page that has more rows before it', () => {
    const first = readPage(rows, { limit: '2' })
    const second = readPage(rows, { limit: '2', cursor: String(first.page.nextCursor) })
    const remaining = rows.slice(0, 4)
    const last = readPage(remaining, { limit: '2', cursor: String(second.page.nextCursor) })
    expect(names(last)).toEqual(['edge-2', 'edge-3'])
    expect(last.page).toMatchObject({ hasNext: false, hasPrev: true, nextCursor: NONE })
    const before = readPage(remaining, {
      limit: '2',
      direction: 'prev',
      cursor: String(last.page.prevCursor),
    })
    expect(names(before)).toEqual(['edge-0', 'edge-1'])
    expect(before.page).toMatchObject({ hasPrev: false, hasNext: true })
  })
})
