// tests/integration/server.test.ts
import { describe, expect, it } from 'vitest'
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
