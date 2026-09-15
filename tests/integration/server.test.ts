// tests/integration/server.test.ts
//
// Lives under tests/integration/ because `@/app` (and `@/server` through it)
// reaches `database.service.ts` at module scope — see CLAUDE.md on why that
// makes a file integration regardless of what it asserts.
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv, trustProxySetting } from '@/configs/env.config'
import { gracefulShutdown, startServer } from '@/server'

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
