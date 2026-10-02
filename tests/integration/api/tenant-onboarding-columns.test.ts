/**
 * @file No tenant response a member receives carries the onboarding columns:
 * POST /tenants, GET /tenants, GET /tenants/:slug and PATCH /tenants/:slug
 * each send the tenant row through the presenter that drops them.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedUser, deleteTrackedUsers, tokenFor } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const slugs: string[] = []
const ONBOARDING_KEYS = [
  'onboardingTracked',
  'onboardingStartedAt',
  'onboardingDismissedAt',
  'onboardingDismissedBy',
]

afterEach(async () => {
  await truncateAuditLogs()
  if (slugs.length > 0) await sql`delete from tenants where slug = any(${slugs})`
  slugs.length = 0
  await deleteTrackedUsers()
})

/**
 * Assert an object carries none of the onboarding columns.
 * @param shown - The tenant as a response carried it.
 */
function expectNoOnboardingColumns(shown: unknown): void {
  expect(shown).toBeTypeOf('object')
  for (const key of ONBOARDING_KEYS) expect(shown).not.toHaveProperty(key)
}

describe('tenant responses', () => {
  it('never carry the onboarding columns', async () => {
    const owner = await createTrackedUser()
    const token = tokenFor(owner)
    const slug = `columns-${randomUUID()}`
    slugs.push(slug)

    const created = await request(app)
      .post('/api/v1/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Columns Co', slug })
    const listed = await request(app).get('/api/v1/tenants').set('Authorization', `Bearer ${token}`)
    const read = await request(app)
      .get(`/api/v1/tenants/${slug}`)
      .set('Authorization', `Bearer ${token}`)
    const updated = await request(app)
      .patch(`/api/v1/tenants/${slug}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Columns Co, renamed' })

    expect([created.status, listed.status, read.status, updated.status]).toEqual([
      201, 200, 200, 200,
    ])
    const body = (response: typeof created): { data: unknown } => response.body as { data: unknown }
    expectNoOnboardingColumns(body(created).data)
    const rows = body(listed).data as Array<{ tenant: unknown }>
    expect(rows).toHaveLength(1)
    expectNoOnboardingColumns(rows[0]?.tenant)
    expectNoOnboardingColumns(body(read).data)
    expectNoOnboardingColumns(body(updated).data)
  })
})
