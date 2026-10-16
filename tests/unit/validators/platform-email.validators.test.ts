/**
 * @file The staff email and suppression queries: filters, the UTC date
 * range, and the suppression state default. Paging params are covered by
 * the shared list schema's tests.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  emailHealthQuerySchema,
  platformEmailListSchema,
  platformSuppressionListSchema,
} from '@/validators/platform-email.validators'

describe('platformEmailListSchema', () => {
  it('has no filters and sorts newest first by default', () => {
    const parsed = platformEmailListSchema.parse({})
    expect(parsed.params).toMatchObject({ limit: 20, direction: 'next' })
    expect(parsed.filters).toEqual({})
  })

  it('accepts every filter together, comma lists included', () => {
    const tenant = randomUUID()
    const user = randomUUID()
    const parsed = platformEmailListSchema.parse({
      search: '  ada@  ',
      status: 'bounced,sent',
      template: 'tenant_invitation',
      tenant,
      user,
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(parsed.params.search).toBe('ada@')
    expect(parsed.filters).toEqual({
      status: ['bounced', 'sent'],
      template: ['tenant_invitation'],
      tenant,
      user,
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('accepts a one-day range (to is inclusive)', () => {
    expect(
      platformEmailListSchema.safeParse({ from: '2026-09-30', to: '2026-09-30' }).success
    ).toBe(true)
  })

  it('refuses to before from', () => {
    const result = platformEmailListSchema.safeParse({ from: '2026-02-01', to: '2026-01-31' })
    expect(result.success).toBe(false)
  })

  it('renames tenantId and userId to tenant and user', () => {
    const id = '0199c4a2-0000-7000-8000-000000000001'
    expect(platformEmailListSchema.parse({ tenant: id, user: id }).filters).toMatchObject({
      tenant: id,
      user: id,
    })
  })

  it.each([
    [{ status: 'opened' }],
    [{ status: 'sent,opened' }],
    [{ template: 'welcome' }],
    [{ tenant: 'not-a-uuid' }],
    [{ user: '42' }],
    [{ from: '2026-9-1' }],
    [{ to: '2026-09-31T00:00:00Z' }],
    [{ sort: 'recipient' }],
  ])('refuses %j', (query) => {
    expect(platformEmailListSchema.safeParse(query).success).toBe(false)
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

describe('platformSuppressionListSchema', () => {
  it('lists active suppressions unless asked', () => {
    expect(platformSuppressionListSchema.parse({}).filters.state).toEqual(['active'])
  })

  it('accepts a comma list of states', () => {
    expect(platformSuppressionListSchema.parse({ state: 'lifted,active' }).filters.state).toEqual([
      'active',
      'lifted',
    ])
  })

  it('refuses an unknown state, the retired all, and prev without a cursor', () => {
    expect(platformSuppressionListSchema.safeParse({ state: 'expired' }).success).toBe(false)
    expect(platformSuppressionListSchema.safeParse({ state: 'all' }).success).toBe(false)
    expect(platformSuppressionListSchema.safeParse({ direction: 'prev' }).success).toBe(false)
  })
})
