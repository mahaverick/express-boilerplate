/**
 * @file Health-probe behaviour: shallow vs. deep checks, the readiness
 * deadline on a stalled database, Redis or queue connection, request-id
 * stamping and the error envelope for unmatched routes.
 */

import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { READINESS_CHECK_DEADLINE_MS } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import { errorHandler } from '@/middlewares/error.middleware'
import { sql } from '@/services/database.service'
import { getQueueConnection, isQueueReachable } from '@/services/queue.service'
import { resetRedisDeadlineForTests, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis } from '@/services/redis.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

const app = createApp()

/**
 * Request the readiness probe, or report that it was still pending after `STALL_ANSWER_BOUND_MS`.
 * @param stalled - Names the stalled dependency, for the failure message.
 * @returns The response.
 */
async function probeWithinBound(stalled: string): Promise<Awaited<ReturnType<typeof get>>> {
  const response = await answerWithinBound(get())
  if (response === 'hung') throw new Error(`GET /health/ready waited on the stalled ${stalled}`)
  return response
}

/**
 * Request the readiness probe now: a supertest request is lazy, and awaiting it inside an async function sends it.
 * @returns The response.
 */
async function get(): Promise<Awaited<ReturnType<ReturnType<typeof request>['get']>>> {
  return request(app).get('/health/ready')
}

/**
 * Wait until the readiness probe answers 200.
 * @param message - Names what has to have recovered.
 * @returns Resolves once it does.
 */
async function waitForReady(message: string): Promise<void> {
  await waitUntil(
    async () => {
      const response = await get()
      return response.status === 200
    },
    { message }
  )
}

/**
 * A ping held until the test settles it, the way a ping written to a queue
 * connection that is connected and does not answer waits until the stall ends.
 * @returns The stand-in ping and functions that settle it.
 */
function heldPing(): {
  ping: () => Promise<'PONG'>
  answer: () => void
  fail: (error: Error) => void
} {
  const held: { resolve?: (reply: 'PONG') => void; reject?: (error: Error) => void } = {}
  const reply = new Promise<'PONG'>((resolve, reject) => {
    held.resolve = resolve
    held.reject = reject
  })
  return {
    ping: async () => reply,
    answer: () => {
      held.resolve?.('PONG')
    },
    fail: (error) => {
      held.reject?.(error)
    },
  }
}

describe('health probes', () => {
  afterEach(() => {
    resetRedisDeadlineForTests()
  })

  it('GET /health is shallow and does not touch the database', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok' })
  })

  it("GET /health carries the release: APP_VERSION, 'dev' outside an image", async () => {
    const response = await request(app).get('/health')
    expect(response.body).toMatchObject({ status: 'ok', release: 'dev' })
  })

  it('GET /health/ready reports each dependency', async () => {
    const response = await request(app).get('/health/ready')
    expect([200, 503]).toContain(response.status)
    expect(response.body).toHaveProperty('checks.database')
    expect(response.body).toHaveProperty('checks.redis')
    expect(response.body).toHaveProperty('checks.queue')
  })

  it('GET /health/ready answers 200 with the unchanged body when every dependency answers', async () => {
    await waitForReady('every dependency is up')
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 'ready',
      checks: { database: true, redis: true, queue: true },
    })
  })

  it('GET /health/ready answers not-ready at its deadline, naming the database, while no pool connection is free', async () => {
    await waitForReady('every dependency is up')
    // Every pool connection held: `select 1` queues, the way it waits on a stalled or exhausted database.
    const held = await Promise.all(
      Array.from({ length: getEnv().DB_POOL_MAX }, async () => sql.reserve())
    )
    try {
      const startedAt = Date.now()
      const responses = await Promise.all([
        probeWithinBound('database'),
        probeWithinBound('database'),
      ])
      // At the deadline, not a fast failure; Node may fire a timer a millisecond early by Date.now().
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(READINESS_CHECK_DEADLINE_MS - 2)
      for (const response of responses) {
        expect(response.status).toBe(503)
        expect(response.body).toEqual({
          status: 'not-ready',
          checks: { database: false, redis: true, queue: true },
          timedOut: ['database'],
        })
      }
    } finally {
      for (const connection of held) connection.release()
    }
    await waitForReady('readiness answers 200 once the pool frees')
  })

  it('GET /health/ready answers not-ready at its deadline, naming the queue, while a queue connection does not answer', async () => {
    await waitUntil(isQueueReachable, { message: 'the queue connections are ready' })
    const stall = heldPing()
    try {
      await withMutatedMethod(getQueueConnection(), 'ping', stall.ping as never, async () => {
        const response = await probeWithinBound('queue connection')
        expect(response.status).toBe(503)
        expect(response.body).toEqual({
          status: 'not-ready',
          checks: { database: true, redis: true, queue: false },
          timedOut: ['queue'],
        })
      })
    } finally {
      // The stall ends: the ping in flight answers, and the next probe is ready.
      stall.answer()
    }
    await waitForReady('readiness answers 200 once the queue connection answers')
  })

  it('GET /health/ready leaves no unhandled rejection when an abandoned queue ping fails later', async () => {
    await waitUntil(isQueueReachable, { message: 'the queue connections are ready' })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const stall = heldPing()
      try {
        await withMutatedMethod(getQueueConnection(), 'ping', stall.ping as never, async () => {
          const response = await probeWithinBound('queue connection')
          expect(response.body).toMatchObject({ timedOut: ['queue'] })
        })
      } finally {
        stall.fail(new Error('Connection is closed.'))
      }
      await waitForReady('readiness answers 200 after the abandoned ping fails')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('GET /health/ready answers not-ready, within the deadline, when Redis is connected but does not answer', async () => {
    const client = await getRedis()
    await withMutatedMethod(client, 'ping', stalledCommand as never, async () => {
      const response = await answerWithinBound((async () => request(app).get('/health/ready'))())
      if (response === 'hung') throw new Error('GET /health/ready waited on the stalled ping')
      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({ status: 'not-ready', checks: { redis: false } })
    })
    // The probe has its own bound: a slow PING opens no cooldown, so request-path calls still ask Redis.
    await expect(withRedisDeadline(async () => client.ping(), 'after the probe')).resolves.toBe(
      'PONG'
    )
    const after = await request(app).get('/health/ready')
    expect(after.body).toMatchObject({ checks: { redis: true } })
  })

  it('stamps a request id on every response', async () => {
    const response = await request(app).get('/health')
    expect(response.get('X-Request-Id')).toMatch(/[\da-f-]{36}/)
  })

  it('echoes a caller-supplied request id', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const response = await request(app).get('/health').set('X-Request-Id', id)
    expect(response.get('X-Request-Id')).toBe(id)
  })

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(app).get('/api/v1/nope')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ success: false, statusCode: 404 })
  })

  it('forwards a rejected promise from an async handler without a wrapper', async () => {
    // Built bare, not via createApp(): its 404 catch-all is already mounted and would match first, making the test pass for the wrong reason.
    const probe = express()
    // Express 5 forwards a rejected handler's promise to the error handler itself; express-async-handler is not installed.
    probe.get('/boom', () => Promise.reject(new HttpError('deliberate', 418)))
    probe.use(errorHandler)
    const response = await request(probe).get('/boom')
    expect(response.status).toBe(418)
  })
})
