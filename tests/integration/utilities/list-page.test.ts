/**
 * @file `listPage` against the real database: forward paging, the capped
 * total counting only the base query's rows, and the edge page an empty
 * cursor read falls back to after concurrent deletes.
 */
import { randomUUID } from 'node:crypto'
import { and, inArray, like, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantModel } from '@/database/models/tenant.model'
import { db } from '@/services/database.service'
import { defineList, listPage, textSort } from '@/utilities/list-page.utilities'
import { listParamsSchema } from '@/validators/list.validators'

const schema = listParamsSchema({ sorts: ['name'], defaultSort: 'name', filters: {} })
const state = { tag: '', slugs: [] as string[] }

/**
 * The tenants whose slug starts with this test's tag, by name.
 */
const tenants = defineList({
  base: (executor, seek) =>
    executor
      .select({
        id: tenantModel.id,
        name: tenantModel.name,
        sortName: sql<string>`lower(${tenantModel.name})`,
      })
      .from(tenantModel)
      .where(and(like(tenantModel.slug, `${state.tag}%`), seek))
      .$dynamic(),
  id: tenantModel.id,
  sorts: { name: [textSort(sql`lower(${tenantModel.name})`, 'asc', 'sortName')] },
  toItem: ({ name }) => name,
})

/**
 * One page of the tagged tenants for raw query values.
 */
function read(query: Record<string, string>) {
  return listPage(db, tenants, schema.parse({ limit: '1', ...query }).params)
}

/**
 * Delete the tagged tenants whose suffix is in `suffixes`.
 */
async function remove(suffixes: string[]): Promise<void> {
  await db.delete(tenantModel).where(
    inArray(
      tenantModel.slug,
      suffixes.map((suffix) => `${state.tag}-${suffix}`)
    )
  )
}

describe('listPage', () => {
  beforeEach(async () => {
    state.tag = `lp${randomUUID().slice(0, 8)}`
    state.slugs = [
      ...['r0', 'r1', 'r2', 'r3'].map((suffix) => `${state.tag}-${suffix}`),
      `other-${state.tag}`,
    ]
    await db.insert(tenantModel).values(state.slugs.map((slug) => ({ name: slug, slug })))
  })

  afterEach(async () => {
    await db.delete(tenantModel).where(inArray(tenantModel.slug, state.slugs))
  })

  it('pages forward without repeating a row and counts only the base query’s rows', async () => {
    const first = await read({ total: '1' })
    expect(first).toMatchObject({
      items: [`${state.tag}-r0`],
      page: { hasNext: true, hasPrev: false },
      total: { count: 4, capped: false },
    })
    const second = await read({ cursor: String(first.page.nextCursor) })
    expect(second.items).toEqual([`${state.tag}-r1`])
    expect(second.total).toBeUndefined()
    expect(second.page.hasPrev).toBe(true)
  })

  it('reads the first page when prev from a cursor finds every earlier row deleted', async () => {
    const first = await read({})
    const second = await read({ cursor: String(first.page.nextCursor) })
    await remove(['r0'])
    const back = await read({ cursor: String(second.page.prevCursor), direction: 'prev' })
    expect(back).toMatchObject({
      items: [`${state.tag}-r1`],
      page: { hasPrev: false, hasNext: true },
    })
  })

  it('reads the last page when next from a cursor finds every later row deleted', async () => {
    const first = await read({})
    const second = await read({ cursor: String(first.page.nextCursor) })
    await remove(['r2', 'r3'])
    const onward = await read({ cursor: String(second.page.nextCursor) })
    expect(onward).toMatchObject({
      items: [`${state.tag}-r1`],
      page: { hasNext: false, hasPrev: true },
    })
  })
})
