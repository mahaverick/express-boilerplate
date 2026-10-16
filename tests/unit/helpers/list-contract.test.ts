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
  createdAt: string
  serial: number
}

const things: Thing[] = []
const BASE = Date.UTC(2026, 0, 1)
const tag = `c${randomUUID().slice(0, 8)}`

const schema = listParamsSchema({
  sorts: ['name', '-name', 'created', '-created', 'serial'],
  defaultSort: 'name',
  filters: { kind: listFilter('kind', ['a', 'b']).optional() },
})

const definition: InMemoryListDefinition<Thing, Thing> = {
  name: 'things',
  id: (thing) => thing.id,
  idValue: z.uuid(),
  sorts: {
    name: [{ direction: 'asc', of: (thing) => thing.name, value: z.string() }],
    '-name': [{ direction: 'desc', of: (thing) => thing.name, value: z.string() }],
    created: [{ direction: 'asc', of: (thing) => thing.createdAt, value: z.string() }],
    '-created': [{ direction: 'desc', of: (thing) => thing.createdAt, value: z.string() }],
    serial: [{ direction: 'asc', of: (thing) => thing.serial, value: z.number() }],
  },
  toItem: (thing) => thing,
}

/**
 * Add `count` things: names and creation times that repeat in pairs, so every sort has ties.
 * @param count - How many.
 */
function seedThings(count: number, kind?: 'a' | 'b'): void {
  for (let index = 0; index < count; index += 1) {
    things.push({
      id: randomUUID(),
      name: `${tag}-${String(Math.floor(index / 2)).padStart(4, '0')}`,
      kind: kind ?? (index % 2 === 0 ? 'a' : 'b'),
      createdAt: new Date(BASE + Math.floor((index + 1) / 2) * 1000).toISOString(),
      serial: index,
    })
  }
}

const app = express()
app.disable('x-powered-by')
app.get('/things', (request: Request, response: Response, next: NextFunction) => {
  try {
    // Stuck-style default: a request filtered to kind b and naming no sort reads newest name first.
    const query =
      request.query.sort === undefined && request.query.kind === 'b'
        ? { ...request.query, sort: '-name' }
        : request.query
    const { params, filters } = parseBody(schema, query)
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
  sorts: ['name', '-name', 'created', '-created', 'serial'],
  order: {
    name: (thing) => (thing as Thing).name,
    '-name': (thing) => (thing as Thing).name,
    created: (thing) => (thing as Thing).createdAt,
    '-created': (thing) => (thing as Thing).createdAt,
    serial: (thing) => (thing as Thing).serial,
  },
  uniqueKeys: ['serial'],
  setup: async () => {},
  seed: (count) => {
    seedThings(count)
    return Promise.resolve()
  },
  clear: () => {
    things.length = 0
    return Promise.resolve()
  },
  teardown: async () => {},
  search: { text: `${tag}-0001`, count: 2 },
  filters: [
    { query: { kind: 'a' }, count: 3 },
    { query: { kind: 'b,a' }, count: 5 },
  ],
})

// A list whose default sort depends on a filter the isolation carries: kind b reads '-name'.
describeListContract({
  name: 'GET /things (isolated to kind b)',
  app: () => app,
  path: () => '/things',
  headers: () => ({}),
  isolate: () => ({ search: tag, kind: 'b' }),
  sorts: ['-name', 'name'],
  defaultSort: (filters) => (filters.kind === 'b' ? '-name' : 'name'),
  order: {
    name: (thing) => (thing as Thing).name,
    '-name': (thing) => (thing as Thing).name,
  },
  setup: async () => {},
  seed: (count) => {
    seedThings(count, 'b')
    return Promise.resolve()
  },
  clear: () => {
    things.length = 0
    return Promise.resolve()
  },
  teardown: async () => {},
  search: { text: `${tag}-0001`, count: 2 },
  filters: [{ query: { kind: 'a,b' }, count: 5 }],
})

describe('the test list seed', () => {
  it('gives every sort key distinct values and a tie', () => {
    things.length = 0
    seedThings(5)
    for (const key of ['name', 'createdAt'] as const) {
      const values = things.map((thing) => thing[key])
      expect(new Set(values).size).toBeGreaterThan(1)
      expect(new Set(values).size).toBeLessThan(values.length)
    }
    things.length = 0
  })
})
