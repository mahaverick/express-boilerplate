/**
 * @file GET /api/v1/platform/flags/unregistered under the shared list
 * contract: the flags the snapshot holds that the registry lacks. Each seed
 * loads its own definitions into the snapshot, and nothing reloads them
 * between cases. Flags are switched on with a mock; the project id and app
 * host come from a mocked `getEnv()`, as in platform-flags.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: 'https://ph.example.test',
      POSTHOG_PROJECT_ID: 4321,
    }),
  }
})

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isFlagsEnabled: () => true }
})

const { createApp } = await import('@/app')
const { startFlagSnapshot, stopFlagSnapshot } =
  await import('@/services/flags/flag-snapshot.service')
const { truncateAuditLogs } = await import('../../helpers/audit-log')
const { betaPageDefinition, flagDefinition, loadFlagDefinitions } =
  await import('../../helpers/flag-definitions')
const { clearFlagKeys } = await import('../../helpers/flag-redis')
const { describeListContract } = await import('../../helpers/list-contract')
const { createTrackedStaff, deleteTrackedUsers } = await import('../../helpers/platform-users')
const { request } = await import('../../helpers/request')

const app = createApp()

/**
 * A short tag unique to this file's run, carried by every seeded flag key.
 */
const tag = `uf${randomUUID().slice(0, 8)}`

/**
 * The bearer token of the staff viewer the file creates.
 */
const staff = { token: '' }

beforeAll(async () => {
  await startFlagSnapshot()
  const viewer = await createTrackedStaff('viewer')
  staff.token = viewer.token
}, 60_000)

afterAll(async () => {
  await loadFlagDefinitions([])
  await stopFlagSnapshot()
  await clearFlagKeys()
  await truncateAuditLogs()
  await deleteTrackedUsers()
}, 60_000)

describeListContract({
  name: 'GET /api/v1/platform/flags/unregistered',
  app: () => app,
  path: () => '/api/v1/platform/flags/unregistered',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  isolate: () => ({ search: `${tag}_u` }),
  sorts: ['key'],
  order: { key: (item) => (item as { key: string }).key },
  uniqueKeys: ['key'],
  // The snapshot and the viewer live for the whole file, beside the rows test below.
  setup: async () => {},
  teardown: async () => {},
  seed: async (count) => {
    await loadFlagDefinitions(
      Array.from({ length: count }, (_unused, index) =>
        flagDefinition(`${tag}_u${String(index).padStart(4, '0')}`)
      )
    )
  },
  clear: async () => {
    await loadFlagDefinitions([])
  },
  idOf: (item) => (item as { key: string }).key,
  search: { text: `${tag}_u0002`, count: 1 },
})

describe('GET /api/v1/platform/flags/unregistered rows', () => {
  it('leaves out a registered flag and links the others to PostHog', async () => {
    const probe = flagDefinition(`${tag}_probe`, { active: false })
    await loadFlagDefinitions([betaPageDefinition(true), probe])

    const response = await request(app)
      .get('/api/v1/platform/flags/unregistered')
      .set('Authorization', `Bearer ${staff.token}`)

    await loadFlagDefinitions([])
    expect(response.status).toBe(200)
    expect((response.body as { data: { items: unknown[] } }).data.items).toEqual([
      {
        key: `${tag}_probe`,
        active: false,
        posthogUrl: `https://ph.example.test/project/4321/feature_flags/${String(probe.id)}`,
      },
    ])
  })
})
