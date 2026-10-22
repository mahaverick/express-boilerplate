/**
 * @file The SQL derivation of onboarding progress, against a registry of
 * its own (two required tenant steps, one optional, one required member
 * step) and a stuck cut-off in 2001, so other files' tenants, all started
 * long after, are never stuck and never in a 2001 funnel. Each state and
 * its precedence, the inclusive stuck boundary, member steps counting by an
 * active owner only, removed keys ignored, the list's order and paging,
 * the funnel's counts, and the stuck count.
 */
import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  PlatformOnboardingRepository,
  type OnboardingProgressOptions,
} from '@/repositories/platform-onboarding.repository'
import { sql } from '@/services/database.service'
import { onboardingTenantListSchema } from '@/validators/platform-onboarding.validators'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  addCompletion,
  addMember,
  createOnboardingTenant,
  DAY_MS,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import { platformTenant } from '../../helpers/platform-staff'
import { deleteTrackedUsers } from '../../helpers/platform-users'

const repository = new PlatformOnboardingRepository()

const T0 = new Date('2001-01-01T00:00:00.000Z')
const STUCK_BEFORE = new Date('2001-01-08T00:00:00.000Z')
const OPTIONS: OnboardingProgressOptions = {
  keys: {
    tenantKeys: ['alpha', 'beta', 'gamma'],
    memberKeys: ['per_person'],
    requiredKeys: ['alpha', 'beta', 'per_person'],
  },
  stuckBefore: STUCK_BEFORE,
}

const NOT_SET = null

/**
 * One tenant's derived state under `OPTIONS`, or undefined when the repository does not find it.
 */
async function stateOf(tenantId: string): Promise<string | undefined> {
  const progress = await repository.findProgress(tenantId, OPTIONS)
  return progress?.state
}

/**
 * The states `list` reads.
 */
type ListedState = 'stuck' | 'in_progress' | 'awaiting_owner'

/**
 * A page of one state's list under `OPTIONS`, in that state's default order: stuck longest first,
 * the others newest first. `query` adds the page size, direction or cursor.
 */
function list(
  state: ListedState,
  query: Record<string, string> = {}
): ReturnType<PlatformOnboardingRepository['listByState']> {
  return repository.listByState(onboardingTenantListSchema.parse({ state, ...query }).params, {
    ...OPTIONS,
    state,
  })
}

/**
 * The ids of a page of `list`, in display order.
 */
async function idsIn(state: ListedState, query: Record<string, string> = {}): Promise<string[]> {
  const page = await list(state, query)
  return page.items.map((row) => row.id)
}

/**
 * The instant `days` days after `T0` (2001-01-01).
 */
function day(days: number): Date {
  return new Date(T0.getTime() + days * DAY_MS)
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

describe('PlatformOnboardingRepository.findProgress: derived state', () => {
  it('is not_tracked for an untracked tenant, whatever else is set', async () => {
    const { tenant } = await createOnboardingTenant({ isTracked: false, startedAt: day(0) })

    expect(await stateOf(tenant.id)).toBe('not_tracked')
  })

  it('is awaiting_owner while tracked with no start, with no last progress', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: NOT_SET, createdAt: day(0) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress?.state).toBe('awaiting_owner')
    expect(progress?.lastProgressAt).toBeNull()
  })

  it('is in_progress when started after the cut-off, last progress being the start', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: day(10) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress).toMatchObject({ state: 'in_progress', requiredDone: 0, doneKeys: [] })
    expect(progress?.lastProgressAt?.toISOString()).toBe(day(10).toISOString())
  })

  it('is stuck from the cut-off on: at it stuck, a millisecond after in progress', async () => {
    const { tenant: atCutOff } = await createOnboardingTenant({ startedAt: STUCK_BEFORE })
    const { tenant: justAfter } = await createOnboardingTenant({
      startedAt: new Date(STUCK_BEFORE.getTime() + 1),
    })
    const { tenant: before } = await createOnboardingTenant({
      startedAt: new Date(STUCK_BEFORE.getTime() - DAY_MS),
    })

    expect(await stateOf(atCutOff.id)).toBe('stuck')
    expect(await stateOf(justAfter.id)).toBe('in_progress')
    expect(await stateOf(before.id)).toBe('stuck')
  })

  it('takes the start as last progress when a completion predates it', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: day(10) })
    await addCompletion(tenant.id, 'alpha', { completedAt: day(1) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress?.state).toBe('in_progress')
    expect(progress?.lastProgressAt?.toISOString()).toBe(day(10).toISOString())
  })

  it('moves last progress to the latest counted completion, which un-sticks the tenant', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: day(0) })
    await addCompletion(tenant.id, 'alpha', { completedAt: day(9) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress).toMatchObject({ state: 'in_progress', requiredDone: 1, doneKeys: ['alpha'] })
    expect(progress?.lastProgressAt?.toISOString()).toBe(day(9).toISOString())
  })

  it('is complete once every required step is done, the optional one not needed', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: day(0) })
    await addCompletion(tenant.id, 'alpha', { completedAt: day(1) })
    await addCompletion(tenant.id, 'per_person', { userId: owner.id, completedAt: day(3) })
    await addCompletion(tenant.id, 'beta', { completedAt: day(2) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress).toMatchObject({ state: 'complete', requiredDone: 3 })
    expect(progress?.doneKeys).toEqual(['alpha', 'beta', 'per_person'])
    expect(progress?.completedAt?.toISOString()).toBe(day(3).toISOString())
  })

  it('is complete over dismissed, and dismissed over stuck', async () => {
    const { tenant: done, owner } = await createOnboardingTenant({
      startedAt: day(0),
      dismissedAt: day(1),
    })
    await addCompletion(done.id, 'alpha', { completedAt: day(1) })
    await addCompletion(done.id, 'beta', { completedAt: day(1) })
    await addCompletion(done.id, 'per_person', { userId: owner.id, completedAt: day(1) })
    const { tenant: dismissedLongAgo } = await createOnboardingTenant({
      startedAt: day(0),
      dismissedAt: day(0),
    })

    expect(await stateOf(done.id)).toBe('complete')
    expect(await stateOf(dismissedLongAgo.id)).toBe('dismissed')
  })

  it('ignores a completion whose key left the registry: no progress, no done key', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: day(0) })
    await addCompletion(tenant.id, 'retired_step', { completedAt: day(12) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress).toMatchObject({ state: 'stuck', doneKeys: [] })
  })

  it('counts a member step done by any active owner, never by a non-owner or a deactivated owner', async () => {
    const { tenant } = await createOnboardingTenant({ startedAt: day(0) })
    const editor = await addMember(tenant, 'editor')
    const deactivatedOwner = await addMember(tenant, 'owner', { isActive: false })
    await addCompletion(tenant.id, 'per_person', { userId: editor.id, completedAt: day(10) })
    await addCompletion(tenant.id, 'per_person', {
      userId: deactivatedOwner.id,
      completedAt: day(11),
    })

    const before = await repository.findProgress(tenant.id, OPTIONS)
    const secondOwner = await addMember(tenant, 'owner')
    await addCompletion(tenant.id, 'per_person', { userId: secondOwner.id, completedAt: day(12) })
    const after = await repository.findProgress(tenant.id, OPTIONS)

    expect(before).toMatchObject({ state: 'stuck', requiredDone: 0, doneKeys: [] })
    expect(after).toMatchObject({ state: 'in_progress', requiredDone: 1, doneKeys: ['per_person'] })
    expect(after?.lastProgressAt?.toISOString()).toBe(day(12).toISOString())
  })

  it('does not count a tenant row for a member step, nor a member row for a tenant step', async () => {
    const { tenant, owner } = await createOnboardingTenant({ startedAt: day(0) })
    await addCompletion(tenant.id, 'per_person', { completedAt: day(10) })
    await addCompletion(tenant.id, 'alpha', { userId: owner.id, completedAt: day(10) })

    const progress = await repository.findProgress(tenant.id, OPTIONS)

    expect(progress).toMatchObject({ state: 'stuck', doneKeys: [] })
  })

  it('reads an archived, soft-deleted tenant, and never the platform tenant or an unknown id', async () => {
    const { tenant } = await createOnboardingTenant({
      startedAt: day(0),
      lifecycleState: 'archived',
    })
    const platform = await platformTenant()

    const archived = await repository.findProgress(tenant.id, OPTIONS)

    expect(archived).toMatchObject({ lifecycleState: 'archived', state: 'stuck' })
    expect(await stateOf(platform.id)).toBeUndefined()
    expect(await stateOf('00000000-0000-7000-8000-000000000000')).toBeUndefined()
  })
})

describe('PlatformOnboardingRepository.listByState', () => {
  it('lists stuck tenants longest stuck first, and pages both ways with the cursors', async () => {
    const { tenant: third } = await createOnboardingTenant({ startedAt: day(3) })
    const { tenant: first } = await createOnboardingTenant({ startedAt: day(1) })
    const { tenant: second } = await createOnboardingTenant({ startedAt: day(2) })

    const all = await list('stuck')
    const pageOne = await list('stuck', { limit: '2' })
    const pageTwo = await list('stuck', { limit: '2', cursor: pageOne.page.nextCursor ?? '' })
    const back = await list('stuck', {
      limit: '2',
      direction: 'prev',
      cursor: pageTwo.page.prevCursor ?? '',
    })

    expect(all.items.map((row) => row.id)).toEqual([first.id, second.id, third.id])
    expect(pageOne.items.map((row) => row.id)).toEqual([first.id, second.id])
    expect(pageOne.page.hasPrev).toBe(false)
    expect(pageTwo.items.map((row) => row.id)).toEqual([third.id])
    expect(pageTwo.page.hasNext).toBe(false)
    expect(back.items.map((row) => row.id)).toEqual([first.id, second.id])
    expect(back.page.hasPrev).toBe(false)
  })

  it('falls back to the last page when the rows after a cursor have gone', async () => {
    const { tenant: first } = await createOnboardingTenant({ startedAt: day(1) })
    const { tenant: second } = await createOnboardingTenant({ startedAt: day(2) })
    const { tenant: last } = await createOnboardingTenant({ startedAt: day(3) })
    const pageOne = await list('stuck', { limit: '2' })
    await sql`update tenants set onboarding_tracked = false where id = ${last.id}`

    const beyond = await list('stuck', { limit: '2', cursor: pageOne.page.nextCursor ?? '' })

    expect(beyond.items.map((row) => row.id)).toEqual([first.id, second.id])
    expect(beyond.page).toMatchObject({ hasNext: false, hasPrev: false })
  })

  it('searches by name within the state, and keeps the state filter', async () => {
    const { tenant: match } = await createOnboardingTenant({ startedAt: day(1) })
    await createOnboardingTenant({ startedAt: day(2) })
    const { tenant: fresh } = await createOnboardingTenant({ startedAt: day(30) })

    const found = await idsIn('stuck', { search: match.name })
    const wrongState = await idsIn('in_progress', { search: match.name })
    const freshStuck = await idsIn('stuck', { search: fresh.name })

    expect(found).toEqual([match.id])
    expect(wrongState).toEqual([])
    expect(freshStuck).toEqual([])
  })

  it('sorts by name and by start, ascending or descending, on request', async () => {
    const { tenant: beta } = await createOnboardingTenant({ startedAt: day(1), name: 'zz-beta' })
    const { tenant: alpha } = await createOnboardingTenant({ startedAt: day(2), name: 'zz-alpha' })

    expect(await idsIn('stuck', { search: 'zz-', sort: 'name' })).toEqual([alpha.id, beta.id])
    expect(await idsIn('stuck', { search: 'zz-', sort: '-started' })).toEqual([alpha.id, beta.id])
    expect(await idsIn('stuck', { search: 'zz-', sort: 'progress' })).toEqual([beta.id, alpha.id])
  })

  it('lists in-progress tenants newest started first', async () => {
    const { tenant: older } = await createOnboardingTenant({ startedAt: day(10) })
    const { tenant: newer } = await createOnboardingTenant({ startedAt: day(11) })

    const ids = await idsIn('in_progress', { limit: '50' })

    expect(ids.indexOf(newer.id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id))
  })

  it('lists tenants awaiting an owner newest created first', async () => {
    const { tenant: older } = await createOnboardingTenant({
      startedAt: NOT_SET,
      createdAt: day(1),
    })
    const { tenant: newer } = await createOnboardingTenant({
      startedAt: NOT_SET,
      createdAt: day(2),
    })

    const ids = await idsIn('awaiting_owner', { limit: '50' })

    expect(ids.indexOf(newer.id)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id))
  })

  it('leaves out suspended, archived and untracked tenants', async () => {
    const { tenant: suspended } = await createOnboardingTenant({
      startedAt: day(1),
      lifecycleState: 'suspended',
    })
    const { tenant: archived } = await createOnboardingTenant({
      startedAt: day(1),
      lifecycleState: 'archived',
    })
    const { tenant: untracked } = await createOnboardingTenant({
      startedAt: day(1),
      isTracked: false,
    })
    const { tenant: listed } = await createOnboardingTenant({ startedAt: day(1) })

    const ids = await idsIn('stuck')

    expect(ids).toEqual([listed.id])
    expect(ids).not.toContain(suspended.id)
    expect(ids).not.toContain(archived.id)
    expect(ids).not.toContain(untracked.id)
  })
})

describe('PlatformOnboardingRepository.funnelCounts', () => {
  it('counts the active, tracked tenants started in the range by state, and each step with its staff share', async () => {
    const from = day(0)
    const to = day(14)
    const { tenant: complete, owner } = await createOnboardingTenant({ startedAt: day(1) })
    await addCompletion(complete.id, 'alpha', {
      source: 'staff',
      completedBy: owner.id,
      reason: 'Set up on a call',
      completedAt: day(2),
    })
    await addCompletion(complete.id, 'beta', { completedAt: day(2) })
    await addCompletion(complete.id, 'per_person', { userId: owner.id, completedAt: day(2) })
    const { tenant: inProgress } = await createOnboardingTenant({ startedAt: day(9) })
    await addCompletion(inProgress.id, 'alpha', { completedAt: day(10) })
    await createOnboardingTenant({ startedAt: day(2) })
    await createOnboardingTenant({ startedAt: day(3), dismissedAt: day(4) })
    await createOnboardingTenant({ startedAt: new Date(from.getTime() - DAY_MS) })
    await createOnboardingTenant({ startedAt: day(3), lifecycleState: 'suspended' })
    // Awaiting an owner: not started, so not in the cohort.
    await createOnboardingTenant({ startedAt: NOT_SET, createdAt: day(3) })

    const counts = await repository.funnelCounts(from, to, OPTIONS)

    const states = Object.fromEntries(counts.states.map((row) => [row.state, row.count]))
    expect(states).toEqual({ complete: 1, in_progress: 1, stuck: 1, dismissed: 1 })
    const steps = Object.fromEntries(counts.steps.map((row) => [row.stepKey, row]))
    expect(steps.alpha).toMatchObject({ completed: 2, staffCompleted: 1 })
    expect(steps.beta).toMatchObject({ completed: 1, staffCompleted: 0 })
    expect(steps.per_person).toMatchObject({ completed: 1, staffCompleted: 0 })
    expect(steps.gamma).toBeUndefined()
  })
})

describe('PlatformOnboardingRepository.countTracked', () => {
  it('counts the active, tracked tenants, started or awaiting an owner, at any start', async () => {
    const before = await repository.countTracked()
    await createOnboardingTenant({ startedAt: day(1) })
    await createOnboardingTenant({ startedAt: new Date(T0.getTime() - 400 * DAY_MS) })
    await createOnboardingTenant({ startedAt: NOT_SET, createdAt: day(3) })
    await createOnboardingTenant({ isTracked: false })
    await createOnboardingTenant({ startedAt: day(1), lifecycleState: 'suspended' })

    const after = await repository.countTracked()

    expect(after - before).toBe(3)
  })
})

describe('PlatformOnboardingRepository.countStuck', () => {
  it('counts the active, tracked tenants that are stuck', async () => {
    const before = await repository.countStuck(OPTIONS)
    await createOnboardingTenant({ startedAt: day(1) })
    await createOnboardingTenant({ startedAt: day(2) })
    await createOnboardingTenant({ startedAt: day(10) })
    await createOnboardingTenant({ startedAt: day(1), lifecycleState: 'suspended' })

    const after = await repository.countStuck(OPTIONS)

    expect(after - before).toBe(2)
  })
})

describe('PlatformOnboardingRepository.latestReminderAt', () => {
  it('is undefined with no reminder, then the newest reminder entry of that tenant only', async () => {
    const { tenant, owner } = await createOnboardingTenant()
    const { tenant: other } = await createOnboardingTenant()
    expect(await repository.latestReminderAt(tenant.id)).toBeUndefined()

    for (const [tenantId, at] of [
      [tenant.id, '2026-09-01T10:00:00.000Z'],
      [tenant.id, '2026-09-03T10:00:00.000Z'],
      [other.id, '2026-09-05T10:00:00.000Z'],
    ] as const) {
      await sql`
        insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, metadata, occurred_at)
        values ('user', ${owner.id}, 'platform', ${tenantId}, 'onboarding.reminder_sent', 'tenant', ${tenantId},
          ${JSON.stringify({ reason: 'x', recipientCount: 1, emailDomains: [], messageIds: [] })}::jsonb, ${at}::timestamptz)
      `
    }

    const latest = await repository.latestReminderAt(tenant.id)

    expect(latest?.toISOString()).toBe('2026-09-03T10:00:00.000Z')
  })
})
