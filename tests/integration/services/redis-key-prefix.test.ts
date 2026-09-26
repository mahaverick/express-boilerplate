// tests/integration/services/redis-key-prefix.test.ts
//
// Every Redis key and channel the app writes sits under REDIS_KEY_PREFIX.
// This file runs under its own prefix nested in this worker's, so every key
// under it is this file's. A before/after diff catches a key created under a
// bare, unprefixed keyspace; other workers and a dev server sharing this
// Redis write under their own prefixes and never match.
import { randomUUID } from 'node:crypto'
import type { RedisClientType } from 'redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { emitNotification } from '@/services/notification-emitter.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { createRedisClient } from '@/services/redis.service'
import { verifyAccessToken } from '@/services/session.service'
import { fakeNotification } from '../../helpers/notification-subscriber'
import { workerRedisKeyPrefix } from '../../helpers/redis-prefix'
import { isEventuallyTrue } from '../../helpers/redis-proxy'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const scope = vi.hoisted(() => ({ workerPrefix: '', prefix: '' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  const real = actual.getEnv()
  scope.workerPrefix = real.REDIS_KEY_PREFIX
  scope.prefix = `${real.REDIS_KEY_PREFIX}:keyscan-${randomUUID()}`
  // The Google credentials only switch the OAuth routes on; nothing calls Google.
  const env = {
    ...real,
    REDIS_KEY_PREFIX: scope.prefix,
    GOOGLE_CLIENT_ID: 'redis-key-prefix-client-id',
    GOOGLE_CLIENT_SECRET: 'redis-key-prefix-client-secret',
  }
  return { ...actual, getEnv: () => env }
})

// The keyspaces this app wrote before REDIS_KEY_PREFIX existed: BullMQ's
// default prefix, the rate limiters, the session denylist, connect-redis's default.
const BARE_KEYSPACE = /^(?:bull|rl|denylist|sess):/
const KEYSPACES = [
  'bull:email',
  'bull:notification',
  'rl:register',
  'rl:login',
  'rl:login-ip',
  'rl:login-account',
  'rl:logout',
  'rl:google-oauth',
  'denylist:session',
  'sess',
] as const
const PASSWORD = 'correct horse battery staple'
const SETTLE_TIMEOUT_MS = 5000

const app = createApp()
const REFRESH_TOKEN_COOKIE_NAME = testRefreshCookie().name
const email = `redis-key-prefix-${randomUUID()}@example.test`
const notifiedUserId = `redis-key-prefix-${randomUUID()}`
const observed: {
  before: Set<string>
  after: string[]
  sessionId: string
  channels: string[]
} = { before: new Set(), after: [], sessionId: '', channels: [] }
const clients: { reader?: RedisClientType; subscriber?: RedisClientType } = {}

/**
 * Every key matching a pattern, via SCAN (never KEYS: this Redis is shared).
 * @param client - A connected, non-subscriber client.
 * @param pattern - The glob to match.
 * @returns The matching keys.
 */
async function scanKeys(client: RedisClientType, pattern = '*'): Promise<string[]> {
  const found: string[] = []
  const batches = client.scanIterator({ MATCH: pattern, COUNT: 500 })
  for await (const keys of batches) {
    found.push(...keys)
  }
  return found
}

/**
 * Whether every expected keyspace has at least one key under this file's prefix.
 * @param keys - Keys under this file's prefix.
 * @returns True once each keyspace is present.
 */
function hasEveryKeyspace(keys: string[]): boolean {
  return KEYSPACES.every((keyspace) =>
    keys.some((key) => key.startsWith(`${scope.prefix}:${keyspace}:`))
  )
}

beforeAll(async () => {
  const reader = createRedisClient()
  const subscriber = createRedisClient()
  clients.reader = reader
  clients.subscriber = subscriber
  await reader.connect()
  await subscriber.connect()
  observed.before = new Set(await scanKeys(reader))
  await subscriber.pSubscribe('*', (message, channel) => {
    if (message.includes(notifiedUserId)) observed.channels.push(channel)
  })

  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD })
  expect(registered.status).toBe(202)
  await sql`update users set email_verified_at = now() where email = ${email}`

  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })
  expect(login.status).toBe(200)
  const { accessToken } = (login.body as { data: { accessToken: string } }).data
  const verified = verifyAccessToken(accessToken)
  if (!verified.ok || verified.payload.sid === undefined) {
    throw new Error('login issued no session id')
  }
  observed.sessionId = verified.payload.sid

  const cookie = (login.headers['set-cookie'] as string[] | undefined)
    ?.find((line) => line.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))
    ?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('login set no refresh cookie')
  const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)
  expect(logout.status).toBe(200)

  const oauthStart = await request(app).get('/api/v1/auth/google')
  expect(oauthStart.status).toBe(302)

  await getEmailQueue().add('redis-key-prefix-probe', { probe: true })
  emitNotification(notifiedUserId, fakeNotification({ userId: notifiedUserId }))

  // Registration enqueues fire-and-forget, and the publish is async: wait for both.
  const hasSettled = await isEventuallyTrue(
    async () =>
      observed.channels.length > 0 && hasEveryKeyspace(await scanKeys(reader, `${scope.prefix}:*`)),
    SETTLE_TIMEOUT_MS
  )
  expect(hasSettled, 'every keyspace and a notification within the settle timeout').toBe(true)
  observed.after = await scanKeys(reader)
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
  await sql`delete from users where email = ${email}`
  const { reader, subscriber } = clients
  if (reader?.isOpen) {
    const leftovers = await scanKeys(reader, `${scope.prefix}:*`)
    if (leftovers.length > 0) await reader.del(leftovers)
    reader.destroy()
  }
  if (subscriber?.isOpen) subscriber.destroy()
})

describe('REDIS_KEY_PREFIX', () => {
  it('gives each vitest worker its own prefix', () => {
    expect(scope.workerPrefix).toBe(workerRedisKeyPrefix(process.env.VITEST_POOL_ID ?? '0'))
  })

  it.each(KEYSPACES)('writes %s under the prefix', (keyspace) => {
    expect(observed.after.some((key) => key.startsWith(`${scope.prefix}:${keyspace}:`))).toBe(true)
  })

  it('writes the denied session under the prefix', () => {
    expect(observed.after).toContain(`${scope.prefix}:denylist:session:${observed.sessionId}`)
  })

  it('creates no key under a bare, unprefixed keyspace', () => {
    const created = observed.after.filter((key) => !observed.before.has(key))
    expect(created.filter((key) => BARE_KEYSPACE.test(key))).toEqual([])
  })

  it("keeps every key naming this file's user, session or prefix under the prefix", () => {
    const mine = observed.after.filter(
      (key) => key.includes(email) || key.includes(observed.sessionId) || key.includes(scope.prefix)
    )
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.filter((key) => !key.startsWith(`${scope.prefix}:`))).toEqual([])
  })

  it('publishes notifications only on the prefixed channel', () => {
    expect(observed.channels.length).toBeGreaterThan(0)
    expect(new Set(observed.channels)).toEqual(new Set([`${scope.prefix}:notifications`]))
  })
})
