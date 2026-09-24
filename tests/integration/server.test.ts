// tests/integration/server.test.ts
//
// Lives under tests/integration/ because `@/app` (and `@/server` through it)
// reaches `database.service.ts` at module scope — see CLAUDE.md on why that
// makes a file integration regardless of what it asserts.
import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv, trustProxySetting } from '@/configs/env.config'
import { UserRepository } from '@/repositories/user.repository'
import { gracefulShutdown, startServer } from '@/server'
import { sql } from '@/services/database.service'
import {
  isShuttingDown,
  markShuttingDown,
  resetLifecycleForTests,
} from '@/services/lifecycle.service'
import { signAccessToken } from '@/utilities/token.utilities'
import { request } from '../helpers/request'

const userRepository = new UserRepository()

async function resolveAfter<T>(ms: number, value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return value
}

/**
 * Open a notification stream and wait for its 200.
 * @param port - The test server's port on 127.0.0.1.
 * @param token - A valid access token.
 * @param headers - Extra request headers.
 * @param agent - The agent to send through; the default has keep-alive off.
 * @returns The request, and a promise that resolves when the server ends the stream.
 */
async function openStream(
  port: number,
  token: string,
  headers: Record<string, string>,
  agent?: http.Agent
): Promise<{ request: http.ClientRequest; ended: Promise<void> }> {
  const streamRequest = http.get(`http://127.0.0.1:${port}/api/v1/notifications/stream`, {
    agent,
    headers: { Authorization: `Bearer ${token}`, ...headers },
  })
  streamRequest.on('error', () => {
    // Expected when the test's cleanup destroys it.
  })
  const response = await new Promise<IncomingMessage>((resolve) => {
    streamRequest.once('response', resolve)
  })
  expect(response.statusCode).toBe(200)
  const ended = new Promise<void>((resolve) => {
    response.on('end', () => resolve())
    response.resume()
  })
  return { request: streamRequest, ended }
}

/**
 * GET a URL through an agent and drain the body.
 * @param url - The URL to fetch.
 * @param agent - The agent to send through.
 * @returns The response status code.
 */
async function getOnce(url: string, agent: http.Agent): Promise<number | undefined> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    http.get(url, { agent }, resolve).on('error', reject)
  })
  await new Promise<void>((resolve) => {
    response.on('end', () => resolve())
    response.resume()
  })
  return response.statusCode
}

describe('graceful shutdown with open notification streams', () => {
  afterEach(() => {
    resetLifecycleForTests()
  })

  it('answers /health/ready with 503 once shutdown has begun', async () => {
    markShuttingDown()
    const response = await request(createApp()).get('/health/ready')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ status: 'shutting-down' })
  })

  it('flips readiness at once, ends open streams (keep-alive included) and resolves within 1.5s', async () => {
    // Bound to 127.0.0.1, matching the URL below; startServer's default bind is `::`.
    const server = createApp().listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const user = await userRepository.create({ email: `server-${randomUUID()}@example.test` })
    const token = signAccessToken(user, randomUUID())
    const keepAliveAgent = new http.Agent({ keepAlive: true })

    // One stream per connection mode; `close` ends the socket with the response.
    const closeStream = await openStream(port, token, { Connection: 'close' })
    const keepAliveStream = await openStream(port, token, {}, keepAliveAgent)
    // A completed request leaves one more idle keep-alive socket behind.
    const health = await getOnce(`http://127.0.0.1:${port}/health`, keepAliveAgent)
    expect(health).toBe(200)

    // Deleted now: gracefulShutdown closes the database pool.
    await sql`delete from users where id = ${user.id}`

    try {
      const shutdown = gracefulShutdown(server)
      // Before the first await: readiness must fail before anything closes.
      expect(isShuttingDown()).toBe(true)
      const outcome = await Promise.race([
        (async () => {
          await shutdown
          return 'shut down' as const
        })(),
        resolveAfter(1500, 'timed out' as const),
      ])
      expect(outcome).toBe('shut down')
      await Promise.all([closeStream.ended, keepAliveStream.ended])
    } finally {
      closeStream.request.destroy()
      keepAliveStream.request.destroy()
      keepAliveAgent.destroy()
      server.closeAllConnections()
    }
  })

  // Runs after the test above has closed the database: this app has no dependencies.
  it('closes a keep-alive socket whose request was still in flight, well before the drain timeout', async () => {
    const app = express()
    app.disable('x-powered-by')
    app.get('/slow', (_request, response) => {
      setTimeout(() => response.json({ ok: true }), 300)
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const keepAliveAgent = new http.Agent({ keepAlive: true })
    const slow = getOnce(`http://127.0.0.1:${port}/slow`, keepAliveAgent)
    await resolveAfter(50, undefined)

    try {
      const startedAt = Date.now()
      await gracefulShutdown(server)
      // Without the idle sweep, the socket stays open until SERVER_DRAIN_TIMEOUT_MS.
      expect(Date.now() - startedAt).toBeLessThan(1500)
      expect(await slow).toBe(200)
    } finally {
      keepAliveAgent.destroy()
      server.closeAllConnections()
    }
  })
})

describe('server lifecycle', () => {
  it('listens, then shuts down without leaving the socket open', async () => {
    // Port 0 passed as an argument, NOT via process.env — getEnv() memoises and
    // database.service already called it at import time, so an env assignment
    // here would be ignored and the server would bind the configured port.
    const server = startServer(0)
    await new Promise((resolve) => server.once('listening', resolve))
    expect(server.listening).toBe(true)

    await gracefulShutdown(server)
    expect(server.listening).toBe(false)
  })

  it('drains dependencies even when they are already closed', async () => {
    // closeDatabase()/closeRedis() are documented as safe to call twice; this
    // guards gracefulShutdown's Promise.allSettled call against ever
    // regressing into an unhandled rejection when a dependency is already down.
    const server = startServer(0)
    await new Promise((resolve) => server.once('listening', resolve))

    await gracefulShutdown(server)
    await expect(gracefulShutdown(server)).resolves.toBeUndefined()
  })
})

describe('trust proxy', () => {
  it('applies the configured TRUST_PROXY setting to the app', () => {
    // The wiring proof for the one line that decides what `request.ip`
    // means, and therefore what every IP-keyed rate limiter actually keys
    // on. Without this assertion, deleting `app.set('trust proxy', ...)`
    // from createApp() breaks nothing visible: the limiters still run, they
    // just silently share one bucket for every client behind the proxy.
    expect(createApp().get('trust proxy')).toBe(trustProxySetting(getEnv().TRUST_PROXY))
  })

  it('leaves request.ip as the socket peer under the configured setting, ignoring a spoofed X-Forwarded-For', async () => {
    // What that setting actually BUYS, probed on a bare app configured by
    // the same expression createApp() uses — a route cannot be added to
    // createApp()'s own app after the fact, since its 404 catch-all is
    // already mounted.
    //
    // The property under test is the one that matters to the limiters: with
    // TRUST_PROXY at its default, a client cannot choose its own `request.ip`
    // — and therefore its own rate-limit bucket — by writing a header. This
    // test tracks the configuration: point TRUST_PROXY at a value that DOES
    // trust the hop and it is expected to change behaviour, which is exactly
    // why the setting is a deployment decision.
    const probe = express()
    probe.set('trust proxy', trustProxySetting(getEnv().TRUST_PROXY))
    probe.get('/whoami', (incoming, response) => {
      response.json({ ip: incoming.ip })
    })

    const response = await request(probe).get('/whoami').set('X-Forwarded-For', '203.0.113.7')

    expect(response.status).toBe(200)
    expect((response.body as { ip: string }).ip).not.toBe('203.0.113.7')
  })
})
