/**
 * @file PlatformEmailRepository: the message search (filters, both paging
 * directions, the ends, rows in the same millisecond), the suppression
 * search, and the batched `canResend` lookups. Every message search is
 * scoped by a per-test tag in the recipient, so rows from other files in
 * this worker never match.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlatformEmailRepository,
  type EmailPageCursor,
} from '@/repositories/platform-email.repository'
import { sql } from '@/services/database.service'
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

function newTag(): string {
  return `e${randomUUID().slice(0, 8)}`
}

/**
 * Five messages for one tag, created a minute apart, oldest first.
 * @param tag - The tag every recipient starts with.
 * @returns Their ids, newest first (the search order).
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

async function idsOf(options: Parameters<PlatformEmailRepository['search']>[0]): Promise<string[]> {
  const page = await repository.search(options)
  return page.rows.map((row) => row.id)
}

describe('PlatformEmailRepository.search', () => {
  it('pages newest first, forward and back, with no prevCursor on the first page', async () => {
    const tag = newTag()
    const ids = await fiveMessages(tag)

    const first = await repository.search({ limit: 2, direction: 'next', q: tag })
    expect(first.rows.map((row) => row.id)).toEqual(ids.slice(0, 2))
    expect(first.prevCursor).toBeUndefined()

    const second = await repository.search({
      limit: 2,
      direction: 'next',
      q: tag,
      cursor: first.nextCursor,
    })
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2, 4))

    const third = await repository.search({
      limit: 2,
      direction: 'next',
      q: tag,
      cursor: second.nextCursor,
    })
    expect(third.rows.map((row) => row.id)).toEqual(ids.slice(4))
    expect(third.nextCursor).toBeUndefined()

    const back = await repository.search({
      limit: 2,
      direction: 'prev',
      q: tag,
      cursor: third.prevCursor,
    })
    expect(back.rows.map((row) => row.id)).toEqual(ids.slice(2, 4))

    const start = await repository.search({
      limit: 2,
      direction: 'prev',
      q: tag,
      cursor: back.prevCursor,
    })
    expect(start.rows.map((row) => row.id)).toEqual(ids.slice(0, 2))
    expect(start.prevCursor).toBeUndefined()
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
    let cursor: EmailPageCursor | undefined
    for (let page = 0; page < 4; page += 1) {
      const result = await repository.search({ limit: 1, direction: 'next', q: tag, cursor })
      seen.push(...result.rows.map((row) => row.id))
      cursor = result.nextCursor
      if (!cursor) break
    }

    expect(seen).toEqual(created.toSorted((a, b) => b.localeCompare(a)))
  })

  it('answers an empty page past the end with the cursor as prevCursor', async () => {
    const tag = newTag()
    await fiveMessages(tag)
    const beyond: EmailPageCursor = { sortAt: '2001-01-01T00:00:00.000000Z', id: randomUUID() }

    const page = await repository.search({ limit: 2, direction: 'next', q: tag, cursor: beyond })

    expect(page.rows).toEqual([])
    expect(page.prevCursor).toEqual(beyond)
  })

  it('matches q case-insensitively and literally for % and _', async () => {
    const tag = newTag()
    const plain = await createTrackedMessage({ recipient: `${tag}-Plain@example.test` })
    const underscored = await createTrackedMessage({ recipient: `${tag}_x@example.test` })

    expect(await idsOf({ limit: 10, direction: 'next', q: tag.toUpperCase() })).toHaveLength(2)
    expect(await idsOf({ limit: 10, direction: 'next', q: `${tag}_` })).toEqual([underscored.id])
    expect(await idsOf({ limit: 10, direction: 'next', q: `${tag}%` })).toEqual([])
    expect(await idsOf({ limit: 10, direction: 'next', q: `${tag}-plain` })).toEqual([plain.id])
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
    const base = { limit: 10, direction: 'next' as const, q: tag }

    expect(await idsOf({ ...base, status: 'bounced' })).toEqual([bounced.id])
    expect(await idsOf({ ...base, templateKey: 'tenant_invitation' })).toEqual([invitation.id])
    expect(await idsOf({ ...base, tenantId })).toEqual([invitation.id])
    expect(await idsOf({ ...base, userId })).toEqual([forUser.id])
    expect(
      await idsOf({
        ...base,
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

describe('PlatformEmailRepository.searchSuppressions', () => {
  it('lists active by default, lifted or all on request, newest first, with the source message', async () => {
    const tag = newTag()
    const message = await createTrackedMessage({ recipient: `${tag}-src@example.test` })
    const event = await addEvent(message.id, 'bounced', { bounceKind: 'hard' })
    const older = await createTrackedSuppression(`${tag}-a@example.test`, {
      sourceEventId: event.id,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    })
    const lifted = await createTrackedSuppression(`${tag}-b@example.test`, { isLifted: true })
    const newer = await createTrackedSuppression(`${tag}-c@example.test`)
    const search = async (state: 'active' | 'lifted' | 'all') => {
      const page = await repository.searchSuppressions({
        limit: 10,
        direction: 'next',
        state,
        q: tag,
      })
      return page.rows
    }

    const active = await search('active')
    expect(active.map((row) => row.id)).toEqual([newer.id, older.id])
    expect(active[1]?.sourceMessageId).toBe(message.id)
    const liftedRows = await search('lifted')
    expect(liftedRows.map((row) => row.id)).toEqual([lifted.id])
    expect(await search('all')).toHaveLength(3)
  })
})
