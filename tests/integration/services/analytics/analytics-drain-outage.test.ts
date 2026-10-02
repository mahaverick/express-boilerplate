/**
 * @file A hanging PostHog never slows the product: with a one-connection
 * pool (`DB_POOL_MAX` 1 in this file's mocked `getEnv()`), API requests that
 * need the database all answer while a drain is still waiting on PostHog.
 * That holds only because the drain's claim releases its connection before
 * the HTTP call; a drain holding it would queue every request behind the
 * hang.
 */
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { UserRepository } from '@/repositories/user.repository'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { startFakePosthog, type FakePosthog } from '../../../helpers/fake-posthog'
import { request } from '../../../helpers/request'
import { waitUntil } from '../../../helpers/timing'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      // Read once, when database.service.ts opens the pool at import, so a literal here.
      DB_POOL_MAX: 1,
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
    }),
  }
})

// Far longer than the API requests below take on one connection, so they finish inside it.
const HANG_MS = 3000
const CONCURRENT_REQUESTS = 5

const state: { posthog?: FakePosthog; app?: Express; userId?: string } = {}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  state.app = createApp()
  await sql`delete from analytics_outbox`
  const user = await new UserRepository().create({
    email: `analytics-outage-${randomUUID()}@example.test`,
  })
  state.userId = user.id
})

afterAll(async () => {
  await sql`delete from analytics_outbox`
  if (state.userId) await sql`delete from users where id = ${state.userId}`
  await state.posthog?.close()
})

describe('a drain waiting on a hanging PostHog', () => {
  it('holds no pool connection: requests that need the database answer while it waits', async () => {
    const { posthog, app, userId } = state
    if (!posthog || !app || !userId) throw new Error('setup did not run')
    const user = await new UserRepository().findById(userId)
    if (!user) throw new Error('user not found')
    const token = signAccessToken(user, randomUUID())
    await sql`
      insert into analytics_outbox (event, distinct_id, properties)
      select 'outage_probe_' || g::text, ${userId}, '{}'::jsonb from generate_series(1, 3) as g`
    posthog.hang(HANG_MS)

    const drain = { isSettled: false }
    const draining = (async () => {
      try {
        return await drainAnalyticsOutbox()
      } finally {
        drain.isSettled = true
      }
    })()
    // The batch has reached PostHog: the drain is now inside the HTTP call.
    await waitUntil(() => posthog.batches.length === 1, { message: 'the batch reached PostHog' })

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        request(app).get('/api/v1/profile').set('Authorization', `Bearer ${token}`)
      )
    )

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: CONCURRENT_REQUESTS }, () => 200)
    )
    expect(drain.isSettled).toBe(false)
    await expect(draining).resolves.toMatchObject({ sent: 3 })
  })
})
