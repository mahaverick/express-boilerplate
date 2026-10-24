/**
 * @file A member's upgrade request, the owners' list of them and a member's
 * banner dismissal, through the real app and this worker's database: a
 * request opens one row and tells each active owner once (a notification
 * carrying the email, the requester's name in the email alone) and sends one
 * `upgrade_requested` event as the requester; a second request while one is
 * open sends nothing; owners, staff and an already-Paid workspace are
 * refused; the request locks the requester's membership, so a removal that
 * holds it wins and leaves no request behind; only an owner lists requests,
 * without addresses or soft-deleted requesters; a dismissal shows in the
 * caller's own `dismissedBanners`. Analytics is switched on by mocking
 * `isAnalyticsEnabled`; no worker runs, so the test reads the queued jobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { ALREADY_PAID_CODE, UPGRADE_REQUEST_OWNER_MESSAGE } from '@/constants/billing.constants'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import type { AnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { User } from '@/database/models/user.model'
import type { NotificationJobData } from '@/jobs/notification.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { UserRepository } from '@/repositories/user.repository'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { sql } from '@/services/database.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { removeMember } from '@/services/tenant-membership.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  deleteTrackedTenants,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  workspace,
} from '../../helpers/billing-api'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'
import { clearRateLimiter } from '../../helpers/sign-in'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  // The real failure mapping, with the fake as the provider.
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const app = createApp()

/**
 * `expect.any(String)` typed as `string`, because vitest types it as `any`.
 */
const ANY_STRING = expect.any(String) as unknown as string

beforeAll(async () => {
  await loadPlans()
  registerAnalyticsSubscribers()
  // An earlier file in this worker may have left jobs, and the tests count the queues.
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
})

afterEach(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await clearRateLimiter(RATE_LIMITS.upgradeRequest.name)
  await clearRateLimiter(RATE_LIMITS.authenticatedWrite.name)
  await sql`delete from analytics_outbox where properties->'$groups'->>'tenant' is not null or properties->>'$group_type' = 'tenant'`
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await forgetProviderPlans()
  await closeQueue()
  await closeRedis()
})

/**
 * POST a JSON body to a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @param body - The JSON body.
 * @returns The response.
 */
function postAs(user: User, path: string, body: object) {
  return request(app)
    .post(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body)
}

/**
 * GET a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @returns The response.
 */
function getAs(user: User, path: string) {
  return request(app)
    .get(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
}

/**
 * A Free workspace with two owners and a viewer named Grace Hopper.
 * @returns The workspace's id and slug, and its people.
 */
async function team(): Promise<{
  tenantId: string
  slug: string
  owner: User
  coOwner: User
  viewer: User
}> {
  const { tenant, owner } = await workspace()
  const coOwner = await createTrackedUser()
  const viewer = await createTrackedUser({ firstName: 'Grace', lastName: 'Hopper' })
  await sql`insert into user_memberships (user_id, tenant_id, role) values (${coOwner.id}, ${tenant.id}, 'owner'), (${viewer.id}, ${tenant.id}, 'viewer')`
  return { tenantId: tenant.id, slug: tenant.slug, owner, coOwner, viewer }
}

/**
 * The queued upgrade-request notifications, by recipient.
 * @returns Each job's data.
 */
async function requestNotices(): Promise<NotificationJobData[]> {
  const jobs = await queuedJobs<NotificationJobData>(getNotificationQueue())
  return jobs
    .map((job) => job.data)
    .filter((data) => data.type === 'billing_upgrade_requested')
    .toSorted((a, b) => a.userId.localeCompare(b.userId))
}

/**
 * A workspace's `upgrade_requested` events.
 * @param tenantId - The workspace.
 * @returns The rows.
 */
async function requestEvents(tenantId: string): Promise<AnalyticsOutboxRow[]> {
  return sql<AnalyticsOutboxRow[]>`
    select id, event, distinct_id as "distinctId", properties, occurred_at as "occurredAt"
    from analytics_outbox
    where event = 'upgrade_requested' and properties->'$groups'->>'tenant' = ${tenantId}`
}

/**
 * A workspace's open upgrade requests.
 * @param tenantId - The workspace.
 * @returns Each request's id and requester.
 */
async function openRequests(tenantId: string): Promise<{ id: string; requestedBy: string }[]> {
  const rows = await sql<
    { id: string; requestedBy: string }[]
  >`select id, requested_by as "requestedBy" from upgrade_requests where tenant_id = ${tenantId} and fulfilled_at is null`
  return [...rows]
}

describe('POST /api/v1/tenants/:slug/upgrade-requests', () => {
  it('opens one request and tells each active owner once, the name in the email only', async () => {
    const { tenantId, slug, owner, coOwner, viewer } = await team()

    const response = await postAs(viewer, `${slug}/upgrade-requests`, {
      key: 'members',
      surface: 'limit',
    })

    expect(response.status).toBe(200)
    const data = (response.body as { data: Record<string, unknown> }).data
    expect(data).toEqual({
      id: ANY_STRING,
      createdAt: ANY_STRING,
      alreadyRequested: false,
    })
    const rows = await openRequests(tenantId)
    expect(rows).toEqual([{ id: data.id, requestedBy: viewer.id }])
    const notices = await requestNotices()
    expect(notices.map((notice) => notice.userId)).toEqual(
      [owner.id, coOwner.id].toSorted((a, b) => a.localeCompare(b))
    )
    for (const notice of notices) {
      expect(`${notice.title} ${notice.body}`).not.toContain('Grace')
      expect(notice.email).toMatchObject({
        templateKey: 'upgrade_requested',
        variables: { requesterName: 'Grace Hopper' },
      })
      const { billingLink } = (notice.email as unknown as { variables: Record<string, string> })
        .variables
      expect(billingLink).toContain('utm_campaign=upgrade_requested')
    }
    // The notification carries the email, so none is queued on its own.
    expect(await queuedJobs(getEmailQueue())).toHaveLength(0)
  })

  it('answers a second request with alreadyRequested and sends nothing new', async () => {
    const { tenantId, slug, viewer } = await team()
    const first = await postAs(viewer, `${slug}/upgrade-requests`, { surface: 'banner' })
    const noticesAfterFirst = await requestNotices()

    const second = await postAs(viewer, `${slug}/upgrade-requests`, {
      key: 'advanced_example',
      surface: 'feature',
    })

    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({
      data: { id: (first.body as { data: { id: string } }).data.id, alreadyRequested: true },
    })
    expect(await openRequests(tenantId)).toHaveLength(1)
    expect(await requestNotices()).toHaveLength(noticesAfterFirst.length)
    expect(await requestEvents(tenantId)).toHaveLength(1)
  })

  it('sends upgrade_requested once, as the requester, with the key, surface and workspace group', async () => {
    const { tenantId, slug, viewer } = await team()

    await postAs(viewer, `${slug}/upgrade-requests`, { key: 'members', surface: 'limit' })
    await postAs(viewer, `${slug}/upgrade-requests`, { key: 'members', surface: 'limit' })

    const events = await requestEvents(tenantId)
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event?.distinctId).toBe(viewer.id)
    expect(event?.properties).toMatchObject({
      key: 'members',
      surface: 'limit',
      plan: 'free',
      billing_state: 'free',
      $groups: { tenant: tenantId },
    })
    // Timed at the request's creation, to the millisecond a JavaScript date holds.
    const [row] = await sql<
      { createdMs: string }[]
    >`select floor(extract(epoch from created_at) * 1000)::bigint::text as "createdMs" from upgrade_requests where tenant_id = ${tenantId}`
    expect(new Date(String(event?.occurredAt)).getTime()).toBe(Number(row?.createdMs))
  })

  it('refuses an owner with 403: owners upgrade from Billing', async () => {
    const { tenantId, slug, owner } = await team()

    const response = await postAs(owner, `${slug}/upgrade-requests`, { surface: 'billing_page' })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ message: UPGRADE_REQUEST_OWNER_MESSAGE })
    expect(await openRequests(tenantId)).toEqual([])
  })

  it('refuses platform staff acting through platform access with 403', async () => {
    const { tenantId, slug } = await team()
    const { user } = await createTrackedStaff('owner')

    const response = await postAs(user, `${slug}/upgrade-requests`, { surface: 'pricing' })

    expect(response.status).toBe(403)
    expect(await openRequests(tenantId)).toEqual([])
    expect(await requestNotices()).toEqual([])
  })

  it('refuses a request on a workspace already paying with 409', async () => {
    const { tenantId, slug, viewer } = await team()
    await makePaying(tenantId)

    const response = await postAs(viewer, `${slug}/upgrade-requests`, { surface: 'pricing' })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: ALREADY_PAID_CODE })
    expect(await openRequests(tenantId)).toEqual([])
  })

  it.each([
    ['an unknown surface', { surface: 'sidebar' }],
    ['no surface', { key: 'members' }],
    ['an unknown key', { key: 'seats', surface: 'limit' }],
    ['an extra field', { surface: 'limit', note: 'please' }],
  ])('refuses %s with 400', async (_label, body) => {
    const { tenantId, slug, viewer } = await team()

    const response = await postAs(viewer, `${slug}/upgrade-requests`, body)

    expect(response.status).toBe(400)
    expect(await openRequests(tenantId)).toEqual([])
  })

  it('waits for a removal that holds the requester’s membership, then refuses and leaves no request', async () => {
    const { tenantId, slug, owner, viewer } = await team()
    const holding = deferred<number>()
    const release = deferred()
    const realClose = BillingRepository.prototype.closeOpenUpgradeRequests

    await withMutatedMethod(
      BillingRepository.prototype,
      'closeOpenUpgradeRequests',
      async function (this: BillingRepository, ...arguments_) {
        const closed = await realClose.apply(this, arguments_)
        holding.resolve(await backendPid(arguments_[2]))
        await release.promise
        return closed
      },
      async () => {
        const removal = removeMember({ userId: owner.id }, tenantId, viewer.id)
        const removerPid = await untilSignalled(holding.promise, removal, 'the removal')
        const asked = postAs(viewer, `${slug}/upgrade-requests`, { surface: 'banner' }).then(
          (response) => response
        )

        expect(await waitForWaiter(removerPid, asked)).toBe(true)
        release.resolve()
        await removal
        const response = await asked

        expect(response.status).toBe(404)
      }
    )
    expect(await openRequests(tenantId)).toEqual([])
    expect(await requestNotices()).toEqual([])
  })

  it('limits a member to 10 requests an hour', async () => {
    const { slug, viewer } = await team()

    for (let attempt = 0; attempt < RATE_LIMITS.upgradeRequest.limit; attempt += 1) {
      const response = await postAs(viewer, `${slug}/upgrade-requests`, { surface: 'banner' })
      expect(response.status).toBe(200)
    }
    const over = await postAs(viewer, `${slug}/upgrade-requests`, { surface: 'banner' })

    expect(over.status).toBe(429)
  })
})

describe('GET /api/v1/tenants/:slug/upgrade-requests', () => {
  it('lists the open requests to an owner with names and no addresses', async () => {
    const { slug, owner, viewer } = await team()
    await postAs(viewer, `${slug}/upgrade-requests`, { key: 'members', surface: 'limit' })

    const response = await getAs(owner, `${slug}/upgrade-requests`)

    expect(response.status).toBe(200)
    expect((response.body as { data: unknown }).data).toEqual([
      {
        id: ANY_STRING,
        requestedBy: { userId: viewer.id, name: 'Grace Hopper' },
        key: 'members',
        createdAt: ANY_STRING,
      },
    ])
    expect(JSON.stringify(response.body)).not.toContain(viewer.email)
  })

  it('leaves out a requester whose account was deleted', async () => {
    const { slug, owner, viewer } = await team()
    await postAs(viewer, `${slug}/upgrade-requests`, { surface: 'banner' })
    await sql`update users set deleted_at = now() where id = ${viewer.id}`

    const response = await getAs(owner, `${slug}/upgrade-requests`)

    expect(response.status).toBe(200)
    expect((response.body as { data: unknown }).data).toEqual([])
  })

  it('reads every requester in one query, and leaves out the one whose account was deleted', async () => {
    const { slug, tenantId, owner, viewer } = await team()
    const editor = await createTrackedUser({ firstName: 'Ada' })
    const gone = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${editor.id}, ${tenantId}, 'editor'), (${gone.id}, ${tenantId}, 'viewer')`
    for (const member of [viewer, editor, gone]) {
      await postAs(member, `${slug}/upgrade-requests`, { surface: 'banner' })
    }
    await sql`update users set deleted_at = now() where id = ${gone.id}`
    const findMany = vi.spyOn(UserRepository.prototype, 'findManyByIds')
    const findOne = vi.spyOn(UserRepository.prototype, 'findById')

    const response = await getAs(owner, `${slug}/upgrade-requests`)

    expect(response.status).toBe(200)
    const listed = (response.body as { data: { requestedBy: { userId: string } }[] }).data
    expect(listed.map((item) => item.requestedBy.userId).toSorted()).toStrictEqual(
      [viewer.id, editor.id].toSorted()
    )
    const lookups = findMany.mock.calls.filter(([ids]) => ids.includes(viewer.id))
    expect(lookups).toHaveLength(1)
    const [[ids] = [[]]] = lookups
    expect([...ids].toSorted()).toStrictEqual([viewer.id, editor.id, gone.id].toSorted())
    expect(findOne.mock.calls.filter(([id]) => id === editor.id)).toStrictEqual([])
    findMany.mockRestore()
    findOne.mockRestore()
  })

  it('refuses anyone but an owner with 403, staff included', async () => {
    const { tenantId, slug, viewer } = await team()
    const admin = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${admin.id}, ${tenantId}, 'admin')`
    const { user: staff } = await createTrackedStaff('owner')

    for (const caller of [viewer, admin, staff]) {
      const response = await getAs(caller, `${slug}/upgrade-requests`)
      expect(response.status).toBe(403)
    }
  })
})

describe('POST /api/v1/tenants/:slug/banner-dismissals', () => {
  it('shows a dismissal in the caller’s own dismissedBanners, and is idempotent', async () => {
    const { slug, owner, viewer } = await team()

    const first = await postAs(viewer, `${slug}/banner-dismissals`, { banner: 'trial_ended' })
    const again = await postAs(viewer, `${slug}/banner-dismissals`, { banner: 'trial_ended' })

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ data: null })
    expect(again.status).toBe(200)
    const viewerBilling = await getAs(viewer, `${slug}/billing`)
    const ownerBilling = await getAs(owner, `${slug}/billing`)
    expect(viewerBilling.body).toMatchObject({ data: { dismissedBanners: ['trial_ended'] } })
    expect(ownerBilling.body).toMatchObject({ data: { dismissedBanners: [] } })
  })

  it('refuses a banner it does not know with 400', async () => {
    const { slug, viewer } = await team()

    const response = await postAs(viewer, `${slug}/banner-dismissals`, { banner: 'payment_failed' })

    expect(response.status).toBe(400)
  })

  it('answers staff acting through platform access as a non-member, with 404', async () => {
    const { slug } = await team()
    const { user } = await createTrackedStaff('owner')

    const response = await postAs(user, `${slug}/banner-dismissals`, { banner: 'trial_ended' })

    expect(response.status).toBe(404)
  })
})
