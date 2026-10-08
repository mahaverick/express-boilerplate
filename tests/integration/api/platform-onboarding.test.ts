/**
 * @file The staff onboarding reads over HTTP: GET /platform/onboarding/funnel,
 * /platform/onboarding/tenants and /platform/tenants/:id/onboarding. The
 * route gates themselves are in platform-route-gates.test.ts; this file
 * covers the bodies, the query validation, the lifecycle reach and the
 * 404s. Other files' tenants share the database, so assertions look at
 * this file's own tenants, and the funnel at the change they make.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { encodeCursor } from '@/utilities/cursor.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addCompletion,
  createOnboardingTenant,
  daysAgo,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  data?: TData
}

// eslint-disable-next-line unicorn/no-null -- an unstarted tenant's onboarding_started_at
const NOT_STARTED = null

interface FunnelBody {
  range: string
  from: string
  totals: Record<string, number>
  completionRate: number | null
  trackedTenants: number
  steps: { key: string; completed: number; staffCompleted: number }[]
}

interface TenantRowBody {
  id: string
  state: string
  owners: { id: string; name: string }[]
  startedAt: string | null
  lastProgressAt: string | null
  daysStuck: number | null
  nextStep: { key: string; title: string } | null
  requiredDone: number
  requiredTotal: number
}

interface PageBody {
  tenants: TenantRowBody[]
  nextCursor: string | null
  prevCursor: string | null
}

const app = createApp()

function get(token: string, path: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get(`/api/v1/platform${path}`)
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

function dataOf<TData>(response: Response): TData {
  const data = (response.body as ApiEnvelope<TData>).data
  if (data === undefined) throw new Error(`no data (status ${response.status})`)
  return data
}

async function viewerToken(): Promise<string> {
  const { token } = await createTrackedStaff('viewer')
  return token
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

describe('GET /api/v1/platform/onboarding/funnel', () => {
  it('answers a viewer with 30 days by default and every registry step in order', async () => {
    const response = await get(await viewerToken(), '/onboarding/funnel')

    expect(response.status).toBe(200)
    const funnel = dataOf<FunnelBody>(response)
    expect(funnel.range).toBe('30d')
    expect(Object.keys(funnel.totals).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'complete',
      'dismissed',
      'inProgress',
      'started',
      'stuck',
    ])
    expect(funnel.steps.map((step) => step.key)).toEqual([
      'configure_settings',
      'invite_teammate',
      'teammate_joined',
      'read_getting_started',
    ])
  })

  it('counts a tenant started in the range, with a staff completion in the staff share', async () => {
    const token = await viewerToken()
    const before = dataOf<FunnelBody>(await get(token, '/onboarding/funnel', { range: '7d' }))
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(2) })
    const { user: staff } = await createTrackedStaff('admin')
    await addCompletion(tenant.id, 'configure_settings', {
      source: 'staff',
      completedBy: staff.id,
      reason: 'Done on the call',
    })
    await createOnboardingTenant({ startedAt: daysAgo(20) })

    const after = dataOf<FunnelBody>(await get(token, '/onboarding/funnel', { range: '7d' }))

    expect((after.totals.started ?? 0) - (before.totals.started ?? 0)).toBe(1)
    const stepOf = (body: FunnelBody) =>
      body.steps.find((step) => step.key === 'configure_settings')
    expect((stepOf(after)?.completed ?? 0) - (stepOf(before)?.completed ?? 0)).toBe(1)
    expect((stepOf(after)?.staffCompleted ?? 0) - (stepOf(before)?.staffCompleted ?? 0)).toBe(1)
  })

  it('counts every tracked tenant in trackedTenants, in or out of the range, started or not', async () => {
    const token = await viewerToken()
    const before = dataOf<FunnelBody>(await get(token, '/onboarding/funnel', { range: '7d' }))
    await createOnboardingTenant({ startedAt: daysAgo(2) })
    await createOnboardingTenant({ startedAt: daysAgo(200) })
    await createOnboardingTenant({ startedAt: NOT_STARTED })
    await createOnboardingTenant({ isTracked: false })

    const after = dataOf<FunnelBody>(await get(token, '/onboarding/funnel', { range: '7d' }))

    expect(after.trackedTenants - before.trackedTenants).toBe(3)
    expect((after.totals.started ?? 0) - (before.totals.started ?? 0)).toBe(1)
  })

  it.each(['7d', '30d', '90d'])('accepts range=%s', async (range) => {
    const response = await get(await viewerToken(), '/onboarding/funnel', { range })
    expect(response.status).toBe(200)
    expect(dataOf<FunnelBody>(response).range).toBe(range)
  })

  it.each(['1d', '365d', ''])('refuses range=%j with a 400', async (range) => {
    const response = await get(await viewerToken(), '/onboarding/funnel', { range })
    expect(response.status).toBe(400)
  })
})

describe('GET /api/v1/platform/onboarding/tenants', () => {
  it('lists stuck tenants by default, with owners, days stuck and the next required step', async () => {
    const { tenant: stuck, owner } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const { tenant: fresh } = await createOnboardingTenant({ startedAt: daysAgo(1) })

    const response = await get(await viewerToken(), '/onboarding/tenants', { limit: '50' })

    expect(response.status).toBe(200)
    const rows = dataOf<PageBody>(response).tenants
    const row = rows.find((candidate) => candidate.id === stuck.id)
    expect(row).toMatchObject({
      state: 'stuck',
      owners: [{ id: owner.id, name: 'Olive Owner' }],
      daysStuck: 10,
      nextStep: { key: 'configure_settings' },
      requiredDone: 0,
      requiredTotal: 2,
    })
    expect(rows.map((candidate) => candidate.id)).not.toContain(fresh.id)
  })

  it('sorts the stuck list longest stuck first and pages with the cursor', async () => {
    const { tenant: longest } = await createOnboardingTenant({ startedAt: daysAgo(300) })
    const { tenant: shorter } = await createOnboardingTenant({ startedAt: daysAgo(299) })
    const token = await viewerToken()

    const pageOne = dataOf<PageBody>(await get(token, '/onboarding/tenants', { limit: '1' }))
    const all = dataOf<PageBody>(await get(token, '/onboarding/tenants', { limit: '50' }))
    const ids = all.tenants.map((row) => row.id)

    expect(ids.indexOf(longest.id)).toBeLessThan(ids.indexOf(shorter.id))
    expect(pageOne.tenants).toHaveLength(1)
    expect(pageOne.prevCursor).toBeNull()
    expect(pageOne.nextCursor).not.toBeNull()
    const pageTwo = dataOf<PageBody>(
      await get(token, '/onboarding/tenants', { limit: '1', cursor: pageOne.nextCursor ?? '' })
    )
    expect(pageTwo.tenants[0]?.id).toBe(ids[1])
    expect(pageTwo.prevCursor).not.toBeNull()
  })

  it.each([
    ['in_progress', { startedAt: daysAgo(1) }],
    // eslint-disable-next-line unicorn/no-null -- awaiting the first owner
    ['awaiting_owner', { startedAt: null }],
    ['dismissed', { startedAt: daysAgo(30), dismissedAt: daysAgo(29) }],
  ] as const)('lists state=%s', async (state, options) => {
    const { tenant } = await createOnboardingTenant(options)

    const response = await get(await viewerToken(), '/onboarding/tenants', {
      state,
      limit: '50',
    })

    const row = dataOf<PageBody>(response).tenants.find((candidate) => candidate.id === tenant.id)
    expect(row?.state).toBe(state)
  })

  it('lists a complete tenant under state=complete', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(5) })
    await addCompletion(tenant.id, 'configure_settings', { completedAt: daysAgo(4) })
    await addCompletion(tenant.id, 'invite_teammate', { completedAt: daysAgo(3) })

    const response = await get(await viewerToken(), '/onboarding/tenants', {
      state: 'complete',
      limit: '50',
    })

    const row = dataOf<PageBody>(response).tenants.find((candidate) => candidate.id === tenant.id)
    expect(row).toMatchObject({ state: 'complete', requiredDone: 2 })
    expect(row?.nextStep).toBeNull()
  })

  it('leaves out a suspended tenant', async () => {
    const { tenant } = await createOnboardingTenant({
      startedAt: daysAgo(10),
      lifecycleState: 'suspended',
    })

    const response = await get(await viewerToken(), '/onboarding/tenants', { limit: '50' })

    expect(dataOf<PageBody>(response).tenants.map((row) => row.id)).not.toContain(tenant.id)
  })

  it.each([
    [{ state: 'not_tracked' }],
    [{ state: 'bogus' }],
    [{ limit: '51' }],
    [{ cursor: 'not-a-cursor' }],
    [{ direction: 'prev' }],
  ])('refuses %j with a 400', async (query) => {
    const response = await get(await viewerToken(), '/onboarding/tenants', query)
    expect(response.status).toBe(400)
  })
})

describe('GET /api/v1/platform/tenants/:id/onboarding', () => {
  it('answers a viewer with the tenant, its state, steps, reminder availability and history', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })

    const response = await get(await viewerToken(), `/tenants/${tenant.id}/onboarding`)

    expect(response.status).toBe(200)
    const detail = dataOf<Record<string, unknown>>(response)
    expect(Object.keys(detail).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'completedAt',
      'daysStuck',
      'dismissedAt',
      'dismissedBy',
      'lastProgressAt',
      'nextStep',
      'reminder',
      'reminders',
      'requiredDone',
      'requiredTotal',
      'startedAt',
      'state',
      'steps',
      'tenant',
    ])
    expect(detail).toMatchObject({
      tenant: { id: tenant.id, slug: tenant.slug, lifecycleState: 'active' },
      state: 'in_progress',
      reminder: { canSend: true, recipientCount: 1, emailDomains: ['example.test'] },
      reminders: [],
    })
  })

  it.each(['suspended', 'archived'] as const)('reads a %s tenant', async (lifecycleState) => {
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1), lifecycleState })

    const response = await get(await viewerToken(), `/tenants/${tenant.id}/onboarding`)

    expect(response.status).toBe(200)
    expect(dataOf<{ tenant: { lifecycleState: string } }>(response).tenant.lifecycleState).toBe(
      lifecycleState
    )
  })

  it('answers 404 Tenant not found for a malformed id, an unknown id and the platform tenant', async () => {
    const token = await viewerToken()
    const platform = await platformTenant()

    for (const id of ['not-a-uuid', randomUUID(), platform.id]) {
      const response = await get(token, `/tenants/${id}/onboarding`)
      expect({ id, status: response.status }).toEqual({ id, status: 404 })
      expect((response.body as ApiEnvelope<unknown>).message).toBe('Tenant not found')
    }
  })
})

describe('out-of-range staff dates are a 400', () => {
  const ID = '01a1156d-00b7-75d4-887f-2dd37e110303'

  it.each([
    [
      '/onboarding/tenants',
      { cursor: encodeCursor({ sortAt: '2026-13-45T25:61:61.000000Z', id: ID }) },
    ],
    [
      '/onboarding/tenants',
      { cursor: encodeCursor({ sortAt: '0000-01-01T00:00:00.000000Z', id: ID }) },
    ],
  ])('GET %s %j', async (path, query) => {
    const { token } = await createTrackedStaff('viewer')
    const response = await request(app)
      .get(`/api/v1/platform${path}`)
      .query(query)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(400)
  })
})
