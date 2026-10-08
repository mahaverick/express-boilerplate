/**
 * @file A fresh process meeting a Redis that accepts the TCP connection and
 * never answers: node-redis's `connectTimeout` stops at the TCP connect, and
 * its handshake has no timer, so without a bound of our own the first
 * `getRedis()` never settles. Request-path calls and the readiness check
 * must still answer within their deadline, and the connect itself must give
 * up after `REDIS_CONNECT_TIMEOUT_MS`, closing its socket, so the next call
 * starts afresh. Its own file because it mocks `getEnv()`'s `REDIS_URL`.
 */
import net from 'node:net'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  closeRedis,
  getRedis,
  isRedisReachable,
  REDIS_CONNECT_TIMEOUT_MS,
} from '@/services/redis.service'
import { isSessionDenied } from '@/services/session-denylist.service'
import { answerWithinBound } from '../../helpers/redis-stall'
import { settle, waitUntil } from '../../helpers/timing'

const target = vi.hoisted(() => ({ url: '' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), REDIS_URL: target.url }) }
})

// Wrapped, not replaced: counts the clients getRedis() creates.
vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>()
  return { ...actual, createClient: vi.fn(actual.createClient) }
})

/**
 * Accepts every connection and never writes a byte.
 */
const silent = { server: net.createServer(), sockets: new Set<net.Socket>() }

/**
 * Whether a promise settles within `ms`, either way.
 * @param operation - The operation under test.
 * @param ms - The bound.
 * @returns `'rejected'`, `'resolved'` or `'hung'`.
 */
async function settleWithin(operation: Promise<unknown>, ms: number): Promise<string> {
  const outcome = (async () => {
    try {
      await operation
      return 'resolved'
    } catch {
      return 'rejected'
    }
  })()
  const timedOut = (async () => {
    await settle(ms, 'hang budget: a pending connect has no event')
    return 'hung'
  })()
  return Promise.race([outcome, timedOut])
}

describe('a Redis that accepts connections and never answers', () => {
  beforeAll(async () => {
    silent.server.on('connection', (socket) => {
      silent.sockets.add(socket)
      // Read and drop the handshake: a paused socket never sees the client's FIN, so its close would never show.
      socket.resume()
      socket.on('error', () => {}).on('close', () => silent.sockets.delete(socket))
    })
    await new Promise<void>((resolve) => {
      silent.server.listen(0, '127.0.0.1', resolve)
    })
    target.url = `redis://127.0.0.1:${String((silent.server.address() as net.AddressInfo).port)}`
  })

  afterAll(async () => {
    await closeRedis()
    for (const socket of silent.sockets) socket.destroy()
    silent.server.close()
  })

  it('answers /health/ready not-reachable within the deadline while the first connect hangs', async () => {
    expect(await answerWithinBound(isRedisReachable())).toBe(false)
  })

  it('fails the denylist read open within the deadline while the first connect hangs', async () => {
    expect(await answerWithinBound(isSessionDenied('session-abc'))).toBe(false)
  })

  it(
    'gives up the connect at REDIS_CONNECT_TIMEOUT_MS, closes its socket, and connects afresh on the next call',
    async () => {
      vi.mocked(createClient).mockClear()
      // The claim is the connect bound itself: twice it, to tell "bounded" from "never".
      expect(await settleWithin(getRedis(), REDIS_CONNECT_TIMEOUT_MS * 2)).toBe('rejected')
      await waitUntil(() => silent.sockets.size === 0, {
        message: 'the abandoned client closed its socket',
      })

      // Left to fail on its own; only its start is the claim.
      void (async () => {
        try {
          await getRedis()
        } catch {
          // The silent server never lets it finish.
        }
      })()
      await waitUntil(() => vi.mocked(createClient).mock.calls.length > 0, {
        message: 'the next call starts a new connect',
      })
    },
    REDIS_CONNECT_TIMEOUT_MS * 3
  )
})
