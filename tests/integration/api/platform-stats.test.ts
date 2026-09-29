/**
 * @file GET /api/v1/platform/stats: the staff Overview's totals and zero-filled
 * daily series. Non-staff get the app's own 404, with no rate-limit headers.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

interface StatsBody {
  range: string
  signups: unknown[]
  emails: unknown[]
  totals: Record<string, number>
}

const app = createApp()
const userRepository = new UserRepository()

function stats(token: string, query: Record<string, string> = {}): Promise<Response> {
  return request(app)
    .get('/api/v1/platform/stats')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

describe('GET /api/v1/platform/stats', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  async function createUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `platform-stats-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  async function createStaff(role: MembershipRole = 'viewer'): Promise<string> {
    const { user, token } = await createUser()
    await makeStaff(user.id, role)
    return token
  }

  it('answers a platform viewer with 7 zero-filled days by default', async () => {
    const response = await stats(await createStaff('viewer'))
    expect(response.status).toBe(200)
    expect(response.headers['ratelimit-limit']).toBe('60')
    const data = (response.body as { data: StatsBody }).data
    expect(data.range).toBe('7d')
    expect(data.signups).toHaveLength(7)
    expect(data.emails).toHaveLength(7)
    expect(Object.keys(data.totals).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'staff',
      'tenants',
      'users',
    ])
    expect(data.totals.staff).toBeGreaterThanOrEqual(1)
  })

  it('answers 30 days for range=30d', async () => {
    const response = await stats(await createStaff('viewer'), { range: '30d' })
    expect(response.status).toBe(200)
    expect((response.body as { data: { signups: unknown[] } }).data.signups).toHaveLength(30)
  })

  it.each(['1d', '365d', ''])('refuses range=%j with a 400', async (range) => {
    const response = await stats(await createStaff('viewer'), { range })
    expect(response.status).toBe(400)
  })

  it("answers a non-staff user with the app's own 404 and no rate-limit headers", async () => {
    const { token } = await createUser()
    const response = await stats(token)
    expect(response.status).toBe(404)
    expect(response.headers['ratelimit-limit']).toBeUndefined()
  })

  it('answers an anonymous caller with a 401', async () => {
    const response = await request(app).get('/api/v1/platform/stats')
    expect(response.status).toBe(401)
  })
})
