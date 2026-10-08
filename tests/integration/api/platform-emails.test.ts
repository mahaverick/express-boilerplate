/**
 * @file The staff email reads: GET /platform/emails, /emails/health,
 * /emails/:id, /emails/:id/preview and /email-suppressions. Access, paging,
 * filters, the detail timeline, the masked preview, and `canResend` for the
 * staff member asking.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { sql } from '@/services/database.service'
import { TOKEN_MASK } from '@/services/platform-email.service'
import { encodeCursor } from '@/utilities/cursor.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addAttempt,
  addEvent,
  createTrackedMessage,
  createTrackedSuppression,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'
import { makeStaff } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
  errors?: Record<string, string[]>
}

interface SummaryBody {
  id: string
  recipient: string
  templateKey: string
  status: string
  user: { id: string; name: string } | null
  tenant: { id: string; name: string; slug: string } | null
  canResend: boolean
}

interface PageBody {
  messages: SummaryBody[]
  nextCursor: string | null
  prevCursor: string | null
}

const app = createApp()
const byText = (a: string, b: string): number => a.localeCompare(b)
const HEX_TOKEN = /[\da-f]{64}/

function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

function get(token: string, path: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get(`/api/v1/platform${path}`)
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending
  return response.status
}

async function canResendAs(token: string, messageId: string): Promise<boolean> {
  const detail = dataOf<SummaryBody>(await get(token, `/emails/${messageId}`))
  return detail.canResend
}

function tagged(): string {
  return `pe${randomUUID().slice(0, 8)}`
}

afterEach(async () => {
  await deleteTrackedEmailRows()
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

describe('GET /api/v1/platform/emails', () => {
  it('admits a platform viewer behind the shared 60-a-minute limiter', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await get(token, '/emails')

    expect(response.status).toBe(200)
    expect(response.headers['ratelimit-limit']).toBe('60')
  })

  it("answers a non-staff user with the app's own 404 and no rate-limit headers", async () => {
    const outsider = await createTrackedUser()

    const response = await get(tokenFor(outsider), '/emails')

    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })

  it('pages newest first with prevCursor null on the first page', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = tagged()
    const older = await createTrackedMessage({
      recipient: `${tag}-a@example.test`,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    })
    const newer = await createTrackedMessage({
      recipient: `${tag}-b@example.test`,
      createdAt: new Date('2026-09-02T00:00:00Z'),
    })

    const first = dataOf<PageBody>(await get(token, '/emails', { q: tag, limit: '1' }))
    expect(first.messages.map((message) => message.id)).toEqual([newer.id])
    expect(first.prevCursor).toBeNull()

    const second = dataOf<PageBody>(
      await get(token, '/emails', { q: tag, limit: '1', cursor: first.nextCursor ?? '' })
    )
    expect(second.messages.map((message) => message.id)).toEqual([older.id])
    expect(second.nextCursor).toBeNull()

    const back = dataOf<PageBody>(
      await get(token, '/emails', {
        q: tag,
        limit: '1',
        direction: 'prev',
        cursor: second.prevCursor ?? '',
      })
    )
    expect(back.messages.map((message) => message.id)).toEqual([newer.id])
  })

  it('filters by an inclusive UTC date range', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = tagged()
    await createTrackedMessage({
      recipient: `${tag}-before@example.test`,
      createdAt: new Date('2026-09-09T23:59:59.999Z'),
    })
    const first = await createTrackedMessage({
      recipient: `${tag}-first@example.test`,
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
    })
    const last = await createTrackedMessage({
      recipient: `${tag}-last@example.test`,
      createdAt: new Date('2026-09-11T23:59:59.999Z'),
    })
    await createTrackedMessage({
      recipient: `${tag}-after@example.test`,
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
    })

    const page = dataOf<PageBody>(
      await get(token, '/emails', { q: tag, from: '2026-09-10', to: '2026-09-11' })
    )

    expect(page.messages.map((message) => message.id)).toEqual([last.id, first.id])
  })

  it('filters by status, template, userId and tenantId', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = tagged()
    const user = await createTrackedUser()
    const tenantId = randomUUID()
    const bounced = await createTrackedMessage({
      recipient: `${tag}-1@example.test`,
      status: 'bounced',
    })
    const mine = await createTrackedMessage({ recipient: `${tag}-2@example.test`, userId: user.id })
    const invitation = await createTrackedMessage({
      recipient: `${tag}-3@example.test`,
      templateKey: 'tenant_invitation',
      tenantId,
    })
    const ids = async (query: Record<string, string>): Promise<string[]> =>
      dataOf<PageBody>(await get(token, '/emails', { q: tag, ...query })).messages.map(
        (message) => message.id
      )

    expect(await ids({ status: 'bounced' })).toEqual([bounced.id])
    expect(await ids({ template: 'tenant_invitation' })).toEqual([invitation.id])
    expect(await ids({ userId: user.id })).toEqual([mine.id])
    expect(await ids({ tenantId })).toEqual([invitation.id])
  })

  it.each([
    [{ direction: 'prev' }],
    [{ status: 'opened' }],
    [{ from: '2026-09-12', to: '2026-09-11' }],
    [{ tenantId: 'nope' }],
    [{ cursor: 'not-a-cursor' }],
  ])('answers 400 for %j', async (query) => {
    const { token } = await createTrackedStaff('viewer')

    const response = await get(token, '/emails', query)

    expect(response.status).toBe(400)
  })

  it('names the user and tenant, or null when their rows are gone', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = tagged()
    const user = await createTrackedUser({ firstName: 'Ada', lastName: 'Lovelace' })
    const named = await createTrackedMessage({
      recipient: `${tag}-1@example.test`,
      userId: user.id,
    })
    const orphan = await createTrackedMessage({
      recipient: `${tag}-2@example.test`,
      userId: randomUUID(),
      tenantId: randomUUID(),
    })

    const page = dataOf<PageBody>(await get(token, '/emails', { q: tag }))
    const byId = new Map(page.messages.map((message) => [message.id, message]))

    expect(byId.get(named.id)?.user).toEqual({ id: user.id, name: 'Ada Lovelace' })
    expect(byId.get(orphan.id)?.user).toBeNull()
    expect(byId.get(orphan.id)?.tenant).toBeNull()
  })
})

describe('canResend', () => {
  it('is true for an admin on a non-staff user’s set-password mail, false for a viewer', async () => {
    const { token: adminToken } = await createTrackedStaff('admin')
    const { token: viewerToken } = await createTrackedStaff('viewer')
    const user = await createTrackedUser()
    const message = await createTrackedMessage({ recipient: user.email, userId: user.id })

    expect(await canResendAs(adminToken, message.id)).toBe(true)
    expect(await canResendAs(viewerToken, message.id)).toBe(false)
  })

  it('is false when the target outranks the actor', async () => {
    const { token } = await createTrackedStaff('admin')
    const owner = await createTrackedUser()
    await makeStaff(owner.id, 'owner')
    const message = await createTrackedMessage({ recipient: owner.email, userId: owner.id })

    expect(await canResendAs(token, message.id)).toBe(false)
  })

  it('is false for a suppressed address', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser()
    const message = await createTrackedMessage({ recipient: user.email, userId: user.id })
    await createTrackedSuppression(user.email.toUpperCase())

    expect(await canResendAs(token, message.id)).toBe(false)
  })

  it.each(['password_changed', 'registration_attempt'])(
    'is false for the security notice %s',
    async (templateKey) => {
      const { token } = await createTrackedStaff('owner')
      const user = await createTrackedUser()
      const message = await createTrackedMessage({
        recipient: user.email,
        userId: user.id,
        templateKey,
        senderClass: 'general',
      })

      expect(await canResendAs(token, message.id)).toBe(false)
    }
  )

  it.each([
    ['a verification resend to a verified user', 'email_verification', {}],
    ['a set-password resend to a deactivated user', 'account_setup', { active: false }],
    [
      'a verification resend to a deactivated user',
      'email_verification',
      { active: false, verified: false },
    ],
  ])('is false, in the detail and the list, for %s', async (_label, templateKey, userOptions) => {
    const { token } = await createTrackedStaff('admin')
    const tag = tagged()
    const user = await createTrackedUser({ email: `${tag}@example.test`, ...userOptions })
    const message = await createTrackedMessage({
      recipient: user.email,
      userId: user.id,
      templateKey,
    })

    const page = dataOf<PageBody>(await get(token, '/emails', { q: tag }))

    expect(await canResendAs(token, message.id)).toBe(false)
    expect(page.messages.find((row) => row.id === message.id)?.canResend).toBe(false)
  })

  it('is true for a verification resend to an unverified, active user', async () => {
    const { token } = await createTrackedStaff('admin')
    const user = await createTrackedUser({ verified: false })
    const message = await createTrackedMessage({
      recipient: user.email,
      userId: user.id,
      templateKey: 'email_verification',
    })

    expect(await canResendAs(token, message.id)).toBe(true)
  })

  it('agrees between the list and the detail', async () => {
    const { token } = await createTrackedStaff('admin')
    const tag = tagged()
    const user = await createTrackedUser({ email: `${tag}@example.test` })
    const message = await createTrackedMessage({ recipient: user.email, userId: user.id })

    const page = dataOf<PageBody>(await get(token, '/emails', { q: tag }))

    expect(page.messages.find((row) => row.id === message.id)?.canResend).toBe(
      await canResendAs(token, message.id)
    )
  })
})

describe('GET /api/v1/platform/emails/:id', () => {
  it('returns the timeline: attempts, events, suppression and the resend chain', async () => {
    const { token } = await createTrackedStaff('viewer')
    const original = await createTrackedMessage({ status: 'bounced' })
    const failedAttempt = await addAttempt(original, 'failed', 'ECONNECTION')
    const sentAttempt = await addAttempt(original, 'sent')
    const bounce = await addEvent(original.id, 'bounced', {
      bounceKind: 'hard',
      detail: 'MESSAGE_REJECTED',
    })
    const suppression = await createTrackedSuppression(original.recipient, {
      sourceEventId: bounce.id,
    })
    const resend = await createTrackedMessage({
      recipient: original.recipient,
      resentFromId: original.id,
    })

    const detail = dataOf<Record<string, unknown>>(await get(token, `/emails/${original.id}`))

    expect(detail).toMatchObject({
      id: original.id,
      status: 'bounced',
      linkApp: 'web',
      // eslint-disable-next-line unicorn/no-null -- JSON null: never failed
      failureOrigin: null,
      // eslint-disable-next-line unicorn/no-null -- JSON null: not a resend
      resentFromId: null,
      resentAsIds: [resend.id],
      suppression: { id: suppression.id, reason: 'hard_bounce' },
      canResend: false,
    })
    expect(detail.attempts).toEqual([
      expect.objectContaining({ id: failedAttempt, status: 'failed', errorCode: 'ECONNECTION' }),
      // eslint-disable-next-line unicorn/no-null -- JSON null: a sent attempt has no code
      expect.objectContaining({ id: sentAttempt, status: 'sent', errorCode: null }),
    ])
    expect(detail.events).toEqual([
      expect.objectContaining({
        id: bounce.id,
        provider: 'fake',
        type: 'bounced',
        bounceKind: 'hard',
        detail: 'MESSAGE_REJECTED',
      }),
    ])
    expect(detail).not.toHaveProperty('variables')

    const resent = dataOf<{ resentFromId: string }>(await get(token, `/emails/${resend.id}`))
    expect(resent.resentFromId).toBe(original.id)
  })

  it('answers 404 for a malformed and an unknown id, and does not read "health" as an id', async () => {
    const { token } = await createTrackedStaff('viewer')

    expect(await statusOf(get(token, '/emails/not-a-uuid'))).toBe(404)
    const unknownId = randomUUID()
    expect(await statusOf(get(token, `/emails/${unknownId}`))).toBe(404)
    expect(await statusOf(get(token, '/emails/health'))).toBe(200)
  })
})

describe('GET /api/v1/platform/emails/:id/preview', () => {
  it('re-renders the stored template with the link masked on the stored frontend', async () => {
    const { token } = await createTrackedStaff('viewer')
    const message = await createTrackedMessage({
      templateKey: 'password_reset',
      linkApp: 'web',
      variables: { firstName: 'Ada', appName: 'Acme' },
    })

    const preview = dataOf<{ subject: string; html: string; text: string; partial: boolean }>(
      await get(token, `/emails/${message.id}/preview`)
    )

    expect(preview.partial).toBe(false)
    expect(preview.subject).toContain('Acme')
    expect(preview.text).toContain('Ada')
    const origin = new URL(getEnv().WEB_URL).origin
    expect(preview.text).toContain(`${origin}/reset-password?token=${TOKEN_MASK}`)
    expect(preview.html).not.toMatch(HEX_TOKEN)
    expect(preview.text).not.toMatch(HEX_TOKEN)
  })

  it('marks a legacy row with no stored variables partial', async () => {
    const { token } = await createTrackedStaff('viewer')
    const legacy = await createTrackedMessage({ templateKey: 'password_changed', variables: {} })

    const preview = dataOf<{ partial: boolean; text: string }>(
      await get(token, `/emails/${legacy.id}/preview`)
    )

    expect(preview.partial).toBe(true)
    expect(preview.text).toContain(TOKEN_MASK)
  })

  it('names the inviter "A teammate", never a stored name', async () => {
    const { token } = await createTrackedStaff('viewer')
    const message = await createTrackedMessage({
      templateKey: 'tenant_invitation',
      variables: {
        tenantName: 'Acme',
        role: 'editor',
        expiresInDays: '7',
        appName: 'Acme',
        inviterName: 'Grace Hopper',
      },
    })

    const preview = dataOf<{ text: string; partial: boolean }>(
      await get(token, `/emails/${message.id}/preview`)
    )

    expect(preview.text).toContain('A teammate invited you to join Acme')
    expect(preview.text).not.toContain('Grace Hopper')
    expect(preview.partial).toBe(false)
  })

  it('answers 409 template_unavailable for a template not in the registry', async () => {
    const { token } = await createTrackedStaff('viewer')
    const message = await createTrackedMessage({ templateKey: 'retired_template' })

    const response = await get(token, `/emails/${message.id}/preview`)

    expect(response.status).toBe(409)
    expect((response.body as ApiEnvelope<unknown>).code).toBe('template_unavailable')
  })
})

describe('GET /api/v1/platform/emails/health', () => {
  it('answers the health shape for 7d by default and 30d on request, 400 otherwise', async () => {
    const { token } = await createTrackedStaff('viewer')

    const week = dataOf<{ range: string; days: unknown[]; rates: Record<string, unknown> }>(
      await get(token, '/emails/health')
    )
    const month = dataOf<{ range: string; days: unknown[] }>(
      await get(token, '/emails/health', { range: '30d' })
    )

    expect(week.range).toBe('7d')
    expect(week.days).toHaveLength(7)
    expect(Object.keys(week.rates).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'bounceRate',
      'clickRate',
      'complaintRate',
      'deliveredRate',
      'openRate',
      'undeliveredRate',
    ])
    expect(month.days).toHaveLength(30)
    expect(await statusOf(get(token, '/emails/health', { range: '90d' }))).toBe(400)
  })
})

describe('GET /api/v1/platform/email-suppressions', () => {
  it('lists active suppressions by default, lifted and all on request, with the lifter named', async () => {
    const { token } = await createTrackedStaff('viewer')
    const tag = tagged()
    const active = await createTrackedSuppression(`${tag}-a@example.test`)
    const lifted = await createTrackedSuppression(`${tag}-b@example.test`, { isLifted: true })
    const lifter = await createTrackedUser({ firstName: 'Grace' })
    await sql`update email_suppressions set lifted_by = ${lifter.id} where id = ${lifted.id}`
    const ids = async (query: Record<string, string>): Promise<string[]> =>
      dataOf<{ suppressions: { id: string }[] }>(
        await get(token, '/email-suppressions', { q: tag, ...query })
      ).suppressions.map((row) => row.id)

    expect(await ids({})).toEqual([active.id])
    expect(await ids({ state: 'lifted' })).toEqual([lifted.id])
    const all = await ids({ state: 'all' })
    expect(all.toSorted(byText)).toEqual([active.id, lifted.id].toSorted(byText))

    const page = dataOf<{ suppressions: Record<string, unknown>[] }>(
      await get(token, '/email-suppressions', { q: tag, state: 'lifted' })
    )
    expect(page.suppressions[0]).toMatchObject({
      address: `${tag}-b@example.test`,
      reason: 'hard_bounce',
      liftedBy: { id: lifter.id, name: 'Grace' },
      liftReason: 'Test lift',
    })
  })

  it("answers a non-staff user with the app's own 404", async () => {
    const outsider = await createTrackedUser()

    const token = tokenFor(outsider)
    expect(await statusOf(get(token, '/email-suppressions'))).toBe(404)
  })
})

describe('out-of-range staff dates are a 400', () => {
  const ID = '01a1156d-00b7-75d4-887f-2dd37e110303'

  it.each([
    ['/emails', { from: '9999-12-31', to: '9999-12-31' }],
    ['/emails', { from: '0000-01-01' }],
    ['/emails', { cursor: encodeCursor({ sortAt: '9999-99-99T99:99:99.999999Z', id: ID }) }],
    [
      '/email-suppressions',
      { cursor: encodeCursor({ sortAt: '2026-02-30T00:00:00.000000Z', id: ID }) },
    ],
  ])('GET %s %j', async (path, query) => {
    const { token } = await createTrackedStaff('viewer')
    const response = await request(app)
      .get(`/api/v1/platform${path}`)
      .query(query)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(400)
  })

  it('still accepts the widest real range and a real cursor', async () => {
    const { token } = await createTrackedStaff('viewer')
    const range = await request(app)
      .get('/api/v1/platform/emails')
      .query({ from: '0001-01-01', to: '9998-12-31' })
      .set('Authorization', `Bearer ${token}`)
    expect(range.status).toBe(200)
    const cursor = await request(app)
      .get('/api/v1/platform/email-suppressions')
      .query({ cursor: encodeCursor({ sortAt: '2024-02-29T23:59:59.999999Z', id: ID }) })
      .set('Authorization', `Bearer ${token}`)
    expect(cursor.status).toBe(200)
  })
})
