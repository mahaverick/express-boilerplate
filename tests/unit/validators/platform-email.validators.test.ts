/**
 * @file The staff email and suppression queries: filters, the UTC date
 * range, the microsecond cursor, and `direction=prev` needing a cursor.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeCursor } from '@/utilities/cursor.utilities'
import {
  emailHealthQuerySchema,
  platformEmailSearchSchema,
  platformSuppressionSearchSchema,
} from '@/validators/platform-email.validators'

const validCursor = (): string =>
  encodeCursor({ sortAt: '2026-09-30T08:15:02.123456Z', id: randomUUID() })

describe('platformEmailSearchSchema', () => {
  it('defaults to the first page, newest first, 20 rows', () => {
    expect(platformEmailSearchSchema.parse({})).toEqual({ direction: 'next', limit: 20 })
  })

  it('accepts every filter together', () => {
    const tenantId = randomUUID()
    const userId = randomUUID()
    const parsed = platformEmailSearchSchema.parse({
      q: '  ada@  ',
      status: 'bounced',
      template: 'tenant_invitation',
      tenantId,
      userId,
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(parsed).toMatchObject({
      q: 'ada@',
      status: 'bounced',
      template: 'tenant_invitation',
      tenantId,
      userId,
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('accepts a one-day range (to is inclusive)', () => {
    expect(
      platformEmailSearchSchema.safeParse({ from: '2026-09-30', to: '2026-09-30' }).success
    ).toBe(true)
  })

  it.each([
    [{ status: 'opened' }],
    [{ template: 'welcome' }],
    [{ tenantId: 'not-a-uuid' }],
    [{ userId: '42' }],
    [{ from: '2026-9-1' }],
    [{ to: '2026-09-31T00:00:00Z' }],
    [{ from: '2026-09-30', to: '2026-09-29' }],
    [{ q: ' '.repeat(3) }],
    [{ limit: '51' }],
    [{ cursor: 'not-a-cursor' }],
    [{ cursor: encodeCursor({ sortAt: '2026-09-30T08:15:02.123Z', id: randomUUID() }) }],
  ])('refuses %j', (query) => {
    expect(platformEmailSearchSchema.safeParse(query).success).toBe(false)
  })

  it('decodes a cursor and pages back with it', () => {
    const parsed = platformEmailSearchSchema.parse({ cursor: validCursor(), direction: 'prev' })
    expect(parsed.cursor?.sortAt).toBe('2026-09-30T08:15:02.123456Z')
    expect(parsed.direction).toBe('prev')
  })

  it('refuses direction=prev without a cursor, naming the cursor field', () => {
    const result = platformEmailSearchSchema.safeParse({ direction: 'prev' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['cursor'])
  })
})

describe('emailHealthQuerySchema', () => {
  it('defaults to 7d and accepts 30d', () => {
    expect(emailHealthQuerySchema.parse({})).toEqual({ range: '7d' })
    expect(emailHealthQuerySchema.parse({ range: '30d' })).toEqual({ range: '30d' })
  })

  it('refuses any other range', () => {
    expect(emailHealthQuerySchema.safeParse({ range: '90d' }).success).toBe(false)
  })
})

describe('platformSuppressionSearchSchema', () => {
  it('defaults to active suppressions', () => {
    expect(platformSuppressionSearchSchema.parse({})).toEqual({
      state: 'active',
      direction: 'next',
      limit: 20,
    })
  })

  it.each(['active', 'lifted', 'all'])('accepts state=%s', (state) => {
    expect(platformSuppressionSearchSchema.parse({ state }).state).toBe(state)
  })

  it('refuses an unknown state and prev without a cursor', () => {
    expect(platformSuppressionSearchSchema.safeParse({ state: 'expired' }).success).toBe(false)
    expect(platformSuppressionSearchSchema.safeParse({ direction: 'prev' }).success).toBe(false)
  })
})
