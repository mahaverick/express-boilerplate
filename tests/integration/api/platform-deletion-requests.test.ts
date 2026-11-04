/**
 * @file GET /api/v1/platform/deletion-requests: the staff list of open
 * account deletion requests, oldest due first, with the workspaces each
 * requester solely owns.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

/**
 * One row of the list, as the tests read it.
 */
interface RequestRowBody {
  id: string
  requestedAt: string
  dueAt: string
  reason: string | null
  user: { id: string; email: string; firstName: string | null; lastName: string | null }
  soleOwnedWorkspaces: { id: string; name: string }[]
}

/**
 * The response envelope, narrowed to the fields these tests read.
 */
interface ApiEnvelope {
  message: string
  data?: { items: RequestRowBody[] }
}

const app = createApp()
const tenantRepository = new TenantRepository()
const createdTenantIds: string[] = []
const tag = `dr${randomUUID().slice(0, 8)}`
const REASON = 'Ticket #4411: customer asked to leave'

/**
 * Create a tracked requester whose address carries this file's tag.
 * @param name - A short label that makes the address findable.
 * @returns The user.
 */
function requester(name: string): Promise<User> {
  return createTrackedUser({ email: `${tag}-${name}@example.test`, firstName: name })
}

/**
 * Open a deletion request for a user.
 * @param userId - The requester.
 * @param dueInDays - Days from now it falls due.
 * @param status - The request's status; a completed one gets a completion time.
 * @param reason - The reason the customer gave, or null for none.
 * @returns The request id.
 */
async function openRequest(
  userId: string,
  dueInDays: number,
  status: 'open' | 'completed' = 'open',
  reason: string | null = 'Moving on'
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into account_deletion_requests (user_id, due_at, status, completed_at, reason)
    values (${userId}, now() + make_interval(days => ${dueInDays}), ${status},
      ${status === 'completed' ? sql`now()` : null}, ${reason})
    returning id`
  return row!.id
}

/**
 * List the open requests this file made.
 * @param token - The staff bearer token.
 * @param query - Query parameters that override the default search.
 * @returns The response.
 */
function list(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/deletion-requests')
    .query({ search: tag, ...query })
    .set('Authorization', `Bearer ${token}`)
}

/**
 * The rows of a list response.
 * @param response - A 200 response.
 * @returns The items.
 */
function itemsOf(response: Response): RequestRowBody[] {
  expect(response.status).toBe(200)
  return (response.body as ApiEnvelope).data?.items ?? []
}

afterEach(async () => {
  await truncateAuditLogs()
  await sql`delete from account_deletion_requests where user_id in (select id from users where email like ${`${tag}-%`})`
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('GET /api/v1/platform/deletion-requests', () => {
  it('lists open requests oldest due first', async () => {
    const { token } = await createTrackedStaff('admin')
    const late = await requester('late')
    const soon = await requester('soon')
    const lateId = await openRequest(late.id, 20)
    const soonId = await openRequest(soon.id, 3)

    const response = await list(token)
    const items = itemsOf(response)

    expect(items.map((item) => item.id)).toEqual([soonId, lateId])
    expect((response.body as ApiEnvelope).message).toBe('Deletion requests retrieved.')
    expect(items[0]).toMatchObject({
      reason: 'Moving on',
      user: { id: soon.id, email: soon.email, firstName: 'soon', lastName: null },
      soleOwnedWorkspaces: [],
    })
    expect(Object.keys(items[0] ?? {}).toSorted()).toEqual([
      'dueAt',
      'id',
      'reason',
      'requestedAt',
      'soleOwnedWorkspaces',
      'user',
    ])
    const desc = itemsOf(await list(token, { sort: '-due' }))
    expect(desc.map((item) => item.id)).toEqual([lateId, soonId])
  })

  it('omits completed requests', async () => {
    const { token } = await createTrackedStaff('admin')
    const open = await requester('open')
    const done = await requester('done')
    const openId = await openRequest(open.id, 5)
    await openRequest(done.id, 1, 'completed')

    expect(itemsOf(await list(token)).map((item) => item.id)).toEqual([openId])
  })

  it("returns each requester's solely owned workspaces", async () => {
    const { token } = await createTrackedStaff('admin')
    const sole = await requester('sole')
    const shared = await requester('shared')
    const coOwner = await requester('coowner')
    const own = await tenantRepository.create({
      name: `Solo ${tag}`,
      slug: `${tag}-solo`,
      ownerId: sole.id,
    })
    const joint = await tenantRepository.create({
      name: `Joint ${tag}`,
      slug: `${tag}-joint`,
      ownerId: shared.id,
    })
    createdTenantIds.push(own.id, joint.id)
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${coOwner.id}, ${joint.id}, 'owner')`
    await openRequest(sole.id, 1)
    await openRequest(shared.id, 2)

    const byEmail = new Map(itemsOf(await list(token)).map((item) => [item.user.email, item]))

    expect(byEmail.get(sole.email)?.soleOwnedWorkspaces).toEqual([
      { id: own.id, name: `Solo ${tag}` },
    ])
    expect(byEmail.get(shared.email)?.soleOwnedWorkspaces).toEqual([])
  })

  it("the list and the delete's 409 name the same workspace", async () => {
    const { token } = await createTrackedStaff('admin')
    const owner = await requester('owner')
    const tenant = await tenantRepository.create({
      name: `Lonely ${tag}`,
      slug: `${tag}-lonely`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    await openRequest(owner.id, 4)

    const listed = itemsOf(await list(token))[0]?.soleOwnedWorkspaces
    expect(listed).toEqual([{ id: tenant.id, name: `Lonely ${tag}` }])

    const refused = await request(app)
      .delete(`/api/v1/platform/users/${owner.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: REASON })
    expect(refused.status).toBe(409)
    expect((refused.body as { message: string }).message).toContain(`Lonely ${tag}`)
  })

  it('drops a request once staff delete the user', async () => {
    const { token } = await createTrackedStaff('admin')
    const leaving = await requester('leaving')
    await openRequest(leaving.id, 2)
    expect(itemsOf(await list(token))).toHaveLength(1)

    const deleted = await request(app)
      .delete(`/api/v1/platform/users/${leaving.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: REASON })
    expect(deleted.status).toBe(200)

    expect(itemsOf(await list(token))).toEqual([])
  })

  it("finds a request by the user's email", async () => {
    const { token } = await createTrackedStaff('admin')
    const ada = await requester('ada')
    const bob = await requester('bob')
    const adaId = await openRequest(ada.id, 2)
    await openRequest(bob.id, 3)

    const response = await list(token, { search: `${tag}-ADA` })

    expect(itemsOf(response).map((item) => item.id)).toEqual([adaId])
  })

  it('still lists the request of a deactivated requester', async () => {
    const { token } = await createTrackedStaff('admin')
    const away = await requester('away')
    const requestId = await openRequest(away.id, 6)
    await sql`update users set active = false where id = ${away.id}`

    const items = itemsOf(await list(token))

    expect(items.map((item) => item.id)).toEqual([requestId])
    expect(items[0]?.user.id).toBe(away.id)
  })

  it('returns a null reason when the customer gave none', async () => {
    const { token } = await createTrackedStaff('admin')
    const quiet = await requester('quiet')
    await openRequest(quiet.id, 6, 'open', null)

    const items = itemsOf(await list(token))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ reason: null })
  })

  it('refuses an unknown sort with 400', async () => {
    const { token } = await createTrackedStaff('admin')
    const response = await list(token, { sort: 'email' })
    expect(response.status).toBe(400)
  })
})
