/**
 * @file PlatformEmailRepository: the message list (filters, both paging
 * directions, the ends, rows in the same millisecond), the suppression
 * list, and the batched `canResend` lookups. Every message list is scoped
 * by a per-test tag in the recipient, so rows from other files in this
 * worker never match.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlatformEmailRepository,
  type PlatformEmailFilters,
} from '@/repositories/platform-email.repository'
import { sql } from '@/services/database.service'
import { listParamsSchema } from '@/validators/list.validators'
import { platformSuppressionListSchema } from '@/validators/platform-email.validators'
import {
  addEvent,
  createTrackedMessage,
  createTrackedSuppression,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'

const repository = new PlatformEmailRepository()

afterEach(async () => {
  await deleteTrackedEmailRows()
})

/**
 * A short random tag for one test's recipients, so a search by it matches only that test's rows.
 */
function newTag(): string {
  return `e${randomUUID().slice(0, 8)}`
}

/**
 * Creates five messages whose recipients start with `tag`, a minute apart, and returns their ids
 * newest first, the search order.
 */
async function fiveMessages(tag: string): Promise<string[]> {
  const base = Date.parse('2026-09-30T08:00:00.000Z')
  const ids: string[] = []
  // Inserted out of order, so the result order comes from the query, not insertion.
  for (const minute of [3, 0, 4, 1, 2]) {
    const message = await createTrackedMessage({
      recipient: `${tag}-${minute}@example.test`,
      createdAt: new Date(base + minute * 60_000),
    })
    ids[minute] = message.id
  }
  return ids.toReversed()
}

/**
 * Shared params for a `-created` list of `search`, parsed as the route parses them.
 * @param search - The search text.
 * @param extra - More query fields (`limit`, `cursor`, `direction`).
 * @returns The parsed params.
 */
function paramsFor(search: string, extra: Record<string, string> = {}) {
  return listParamsSchema({ sorts: ['-created'], defaultSort: '-created', filters: {} }).parse({
    search,
    ...extra,
  }).params
}

/**
 * A cursor a page must have handed back.
 * @param cursor - The page's `nextCursor` or `prevCursor`.
 * @returns The cursor.
 * @throws {Error} When the page has none.
 */
function required(cursor: string | null): string {
  if (cursor === null) throw new Error('expected the page to hand back a cursor')
  return cursor
}

/**
 * Lists this tag's messages and keeps only the ids of the rows it found, for filter assertions.
 * @param tag - The test's recipient tag.
 * @param filters - The filters.
 * @returns The ids, newest first.
 */
async function idsOf(tag: string, filters: PlatformEmailFilters): Promise<string[]> {
  const page = await repository.list(paramsFor(tag, { limit: '10' }), filters)
  return page.items.map((row) => row.id)
}

describe('PlatformEmailRepository.list', () => {
  it('pages newest first, forward and back, with no prevCursor on the first page', async () => {
    const tag = newTag()
    const ids = await fiveMessages(tag)

    const first = await repository.list(paramsFor(tag, { limit: '2' }), {})
    expect(first.items.map((row) => row.id)).toEqual(ids.slice(0, 2))
    expect(first.page.prevCursor).toBeNull()

    const second = await repository.list(
      paramsFor(tag, { limit: '2', cursor: required(first.page.nextCursor) }),
      {}
    )
    expect(second.items.map((row) => row.id)).toEqual(ids.slice(2, 4))

    const third = await repository.list(
      paramsFor(tag, { limit: '2', cursor: required(second.page.nextCursor) }),
      {}
    )
    expect(third.items.map((row) => row.id)).toEqual(ids.slice(4))
    expect(third.page.nextCursor).toBeNull()

    const back = await repository.list(
      paramsFor(tag, { limit: '2', direction: 'prev', cursor: required(third.page.prevCursor) }),
      {}
    )
    expect(back.items.map((row) => row.id)).toEqual(ids.slice(2, 4))

    const start = await repository.list(
      paramsFor(tag, { limit: '2', direction: 'prev', cursor: required(back.page.prevCursor) }),
      {}
    )
    expect(start.items.map((row) => row.id)).toEqual(ids.slice(0, 2))
    expect(start.page.prevCursor).toBeNull()
  })

  it('never skips rows created in the same millisecond at a page boundary', async () => {
    const tag = newTag()
    // created_at keeps milliseconds, so the four rows tie and the id breaks the tie.
    const createdAt = '2026-09-30T09:00:00.123Z'
    const created: string[] = []
    for (const index of ['1', '2', '3', '4']) {
      const message = await createTrackedMessage({ recipient: `${tag}-${index}@example.test` })
      await sql`update email_messages set created_at = ${createdAt}::timestamptz where id = ${message.id}`
      created.push(message.id)
    }

    const seen: string[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 4; page += 1) {
      const result = await repository.list(
        paramsFor(tag, { limit: '1', ...(typeof cursor === 'string' && { cursor }) }),
        {}
      )
      seen.push(...result.items.map((row) => row.id))
      cursor = result.page.nextCursor
      if (typeof cursor !== 'string') break
    }

    expect(seen).toEqual(created.toSorted((a, b) => b.localeCompare(a)))
  })

  it('answers the last page when the rows after the cursor are gone, with a way back', async () => {
    const tag = newTag()
    const ids = await fiveMessages(tag)
    const first = await repository.list(paramsFor(tag, { limit: '4' }), {})
    const cursor = required(first.page.nextCursor)
    // The only row after the cursor is deleted, so the read finds nothing there.
    await sql`delete from email_messages where id = ${ids[4] ?? ''}`

    const page = await repository.list(paramsFor(tag, { limit: '2', cursor }), {})

    expect(page.items.map((row) => row.id)).toEqual(ids.slice(2, 4))
    expect(page.page.hasNext).toBe(false)
    expect(page.page.hasPrev).toBe(true)
  })

  it('matches search case-insensitively and literally for % and _', async () => {
    const tag = newTag()
    const plain = await createTrackedMessage({ recipient: `${tag}-Plain@example.test` })
    const underscored = await createTrackedMessage({ recipient: `${tag}_x@example.test` })

    expect(await idsOf(tag.toUpperCase(), {})).toHaveLength(2)
    expect(await idsOf(`${tag}_`, {})).toEqual([underscored.id])
    expect(await idsOf(`${tag}%`, {})).toEqual([])
    expect(await idsOf(`${tag}-plain`, {})).toEqual([plain.id])
  })

  it('filters by status, template, tenant, user and the created range', async () => {
    const tag = newTag()
    const tenantId = randomUUID()
    const userId = randomUUID()
    const bounced = await createTrackedMessage({
      recipient: `${tag}-a@example.test`,
      status: 'bounced',
      createdAt: new Date('2026-09-10T23:59:59.999Z'),
    })
    const invitation = await createTrackedMessage({
      recipient: `${tag}-b@example.test`,
      templateKey: 'tenant_invitation',
      tenantId,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
    })
    const forUser = await createTrackedMessage({
      recipient: `${tag}-c@example.test`,
      userId,
      createdAt: new Date('2026-09-12T12:00:00.000Z'),
    })

    expect(await idsOf(tag, { statuses: ['bounced'] })).toEqual([bounced.id])
    expect(await idsOf(tag, { templateKeys: ['tenant_invitation'] })).toEqual([invitation.id])
    expect(await idsOf(tag, { tenantId })).toEqual([invitation.id])
    expect(await idsOf(tag, { userId })).toEqual([forUser.id])
    expect(
      await idsOf(tag, {
        createdFrom: new Date('2026-09-11T00:00:00.000Z'),
        createdBefore: new Date('2026-09-12T00:00:00.000Z'),
      })
    ).toEqual([invitation.id])
  })

  it('joins the user and tenant, and answers null for ids that match no row', async () => {
    const message = await createTrackedMessage({ userId: randomUUID(), tenantId: randomUUID() })

    const found = await repository.findRecord(message.id)

    expect(found?.id).toBe(message.id)
    expect(found?.user).toBeNull()
    expect(found?.tenant).toBeNull()
    expect(found).not.toHaveProperty('variables')
    expect(await repository.findRecord(randomUUID())).toBeUndefined()
  })
})

describe('PlatformEmailRepository detail reads', () => {
  it('lists events in the order they occurred and the resends of a message', async () => {
    const original = await createTrackedMessage()
    const later = await addEvent(original.id, 'delivered', {
      occurredAt: new Date('2026-09-30T10:00:00Z'),
    })
    const earlier = await addEvent(original.id, 'deferred', {
      occurredAt: new Date('2026-09-30T09:00:00Z'),
    })
    const resend = await createTrackedMessage({ resentFromId: original.id })

    const events = await repository.listEvents(original.id)
    expect(events.map((event) => event.id)).toEqual([earlier.id, later.id])
    expect(await repository.listResentAsIds(original.id)).toEqual([resend.id])
  })

  it('finds active suppressions case-insensitively and ignores lifted ones', async () => {
    const active = `sup-${randomUUID()}@example.test`
    const lifted = `sup-${randomUUID()}@example.test`
    const suppression = await createTrackedSuppression(active)
    await createTrackedSuppression(lifted, { isLifted: true })

    const found = await repository.activeSuppressionsFor([active.toUpperCase(), lifted])

    expect(found.size).toBe(1)
    expect(found.has(active)).toBe(true)
    expect(found.get(active)?.id).toBe(suppression.id)
  })
})

describe('PlatformEmailRepository.listSuppressions', () => {
  it('lists active by default, lifted or both on request, newest first, with the source message', async () => {
    const tag = newTag()
    const message = await createTrackedMessage({ recipient: `${tag}-src@example.test` })
    const event = await addEvent(message.id, 'bounced', { bounceKind: 'hard' })
    const older = await createTrackedSuppression(`${tag}-a@example.test`, {
      sourceEventId: event.id,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    })
    const lifted = await createTrackedSuppression(`${tag}-b@example.test`, { isLifted: true })
    const newer = await createTrackedSuppression(`${tag}-c@example.test`)
    /**
     * Lists this test's suppressions for a state query, parsed as the route parses it.
     * @param state - The `state` query value, or undefined for the default.
     * @returns The rows, in page order.
     */
    const list = async (state?: string) => {
      const { params, filters } = platformSuppressionListSchema.parse({
        search: tag,
        limit: '10',
        ...(state !== undefined && { state }),
      })
      const page = await repository.listSuppressions(params, { states: filters.state })
      return page.items
    }

    const active = await list()
    expect(active.map((row) => row.id)).toEqual([newer.id, older.id])
    expect(active[1]?.sourceMessageId).toBe(message.id)
    const liftedRows = await list('lifted')
    expect(liftedRows.map((row) => row.id)).toEqual([lifted.id])
    expect(await list('active,lifted')).toHaveLength(3)
  })
})
