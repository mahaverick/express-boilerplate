/**
 * @file Two small staff-surface additions: one structured log line per
 * successful /platform write (never its body), and the platform audit log's
 * `targetId` filter, which the Apex History cards read.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const REASON = 'Ticket 77: customer verified by phone'
const createdSlugs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAuditLogs()
  if (createdSlugs.length > 0) await sql`delete from tenants where slug = any(${createdSlugs})`
  createdSlugs.length = 0
  await deleteTrackedUsers()
})

describe('logStaffWrites', () => {
  it('logs a successful staff write once, with method, path, status, actor and target, and never the body', async () => {
    const { user: admin, token } = await createTrackedStaff('admin')
    const target = await createTrackedUser({ active: false })
    const info = vi.spyOn(logger, 'info')

    const response = await request(app)
      .post(`/api/v1/platform/users/${target.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: REASON })

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith('Staff write', {
        method: 'POST',
        path: `/api/v1/platform/users/${target.id}/reactivate`,
        status: 200,
        actorId: admin.id,
        targetType: 'user',
        targetId: target.id,
      })
    })
    const staffWrites = info.mock.calls.filter(([message]) => message === 'Staff write')
    expect(staffWrites).toHaveLength(1)
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).not.toContain(REASON)
    expect(logged).not.toContain(target.email)
    expect(logged).not.toContain(admin.email)
  })

  it('logs a tenant create, whose path names no target, without the owner address', async () => {
    const { user: admin, token } = await createTrackedStaff('admin')
    const slug = `log-${randomUUID().slice(0, 8)}`
    createdSlugs.push(slug)
    const info = vi.spyOn(logger, 'info')

    const created = await request(app)
      .post('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Log Co', slug, ownerEmail: `owner-${admin.id}@example.test` })

    expect(created.status).toBe(201)
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith('Staff write', {
        method: 'POST',
        path: '/api/v1/platform/tenants',
        status: 201,
        actorId: admin.id,
      })
    })
    expect(JSON.stringify(info.mock.calls)).not.toContain(`owner-${admin.id}@example.test`)
  })

  it('logs neither a refused write nor a read', async () => {
    const { token } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    const info = vi.spyOn(logger, 'info')

    const refused = await request(app)
      .post(`/api/v1/platform/users/${target.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: REASON })
    const read = await request(app)
      .get(`/api/v1/platform/users/${target.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(refused.status).toBe(409)
    expect(read.status).toBe(200)
    expect(info.mock.calls.some(([message]) => message === 'Staff write')).toBe(false)
  })
})

describe('logStaffWrites and callers the role gate refuses', () => {
  it('logs nothing for a non-staff OPTIONS or POST naming a target', async () => {
    const outsider = await createTrackedUser()
    const target = await createTrackedUser({ active: false })
    const token = tokenFor(outsider)
    const info = vi.spyOn(logger, 'info')

    const options = await request(app)
      .options(`/api/v1/platform/users/${target.id}/reactivate`)
      // A refused origin: cors passes it on to the routers instead of answering it.
      .set('Origin', 'https://not-allowed.example')
      .set('Authorization', `Bearer ${token}`)
    const post = await request(app)
      .post(`/api/v1/platform/users/${target.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: REASON })

    expect([options.status, post.status]).toEqual([404, 404])
    expect(info.mock.calls.some(([message]) => message === 'Staff write')).toBe(false)
  })
})

describe('GET /api/v1/platform/audit-log?targetId=', () => {
  it('returns only the entries about one target', async () => {
    const { token } = await createTrackedStaff('admin')
    const first = await createTrackedUser({ active: false })
    const second = await createTrackedUser({ active: false })
    for (const target of [first, second]) {
      await request(app)
        .post(`/api/v1/platform/users/${target.id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: REASON })
    }

    const response = await request(app)
      .get('/api/v1/platform/audit-log')
      .query({ targetId: first.id })
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    const entries = (response.body as { data: { entries: { target: { id: string } }[] } }).data
      .entries
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.target.id === first.id)).toBe(true)
  })

  it('answers 400 for a targetId that is not a uuid', async () => {
    const { token } = await createTrackedStaff('admin')

    const response = await request(app)
      .get('/api/v1/platform/audit-log')
      .query({ targetId: 'nope' })
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(400)
  })
})
