/**
 * @file An uncaught exception in a real `src/index.ts` process: the child
 * reports it to a fake PostHog before it exits 1, and boot raised V8's stack
 * depth to `ERROR_FRAME_LIMIT` first. The child's database and Redis point
 * at port 1, so it reaches no shared service; `tests/helpers/process-fault-preload.ts`
 * throws once boot has installed its listener. What the event carries beyond
 * its capture point is the reporter's. A second child faults while PostHog
 * holds the report: during that fatal flush it is already out of rotation,
 * and a SIGTERM then still exits 1.
 */
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ERROR_FRAME_LIMIT } from '@/constants/error-tracking.constants'
import { startFakePosthog, type FakePosthog } from '../helpers/fake-posthog'

const execFileAsync = promisify(execFile)
const fake: { posthog?: FakePosthog } = {}

/**
 * A port no process is listening on at the moment, chosen by the OS.
 * @returns The port.
 */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * The environment of a child `src/index.ts` that reaches no shared service.
 * @param posthog - The fake PostHog it reports to.
 * @param port - The port it listens on.
 * @returns The environment.
 */
function childEnv(posthog: FakePosthog, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_PORT: String(port),
    DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
    REDIS_URL: 'redis://127.0.0.1:1',
    WORKER_ENABLED: 'false',
    POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
    POSTHOG_HOST: posthog.url,
    ERROR_TRACKING_ENABLED: 'true',
    SHUTDOWN_TIMEOUT_MS: '5000',
  }
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('a process fault', () => {
  it('reaches PostHog before the process exits 1, with boot-time stack depth', async () => {
    const posthog = fake.posthog
    if (!posthog) throw new Error('the fake PostHog is not running')
    let failure: { code?: number } = {}
    try {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--import', './tests/helpers/process-fault-preload.ts', 'src/index.ts'],
        {
          env: childEnv(posthog, await freePort()),
          timeout: 20_000,
        }
      )
    } catch (error) {
      failure = error as { code?: number }
    }

    expect(failure.code).toBe(1)
    const exceptions = posthog.batches.flat().filter((event) => event.event === '$exception')
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]?.properties).toMatchObject({ capture_point: 'process' })
    expect(JSON.stringify(exceptions[0]?.properties.$exception_list)).toContain(
      `stack limit ${String(ERROR_FRAME_LIMIT)}`
    )
  }, 30_000)

  it('leaves rotation during the fatal flush, and a SIGTERM then still exits 1', async () => {
    const posthog = fake.posthog
    if (!posthog) throw new Error('the fake PostHog is not running')
    const before = posthog.requests.length
    // Longer than the fatal flush's deadline, so the flush is still waiting when the test acts.
    posthog.hang(10_000)
    const port = await freePort()
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', './tests/helpers/process-fault-preload.ts', 'src/index.ts'],
      { env: childEnv(posthog, port), stdio: 'ignore' }
    )
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
    })
    try {
      await vi.waitFor(() => expect(posthog.requests.length).toBeGreaterThan(before), {
        timeout: 15_000,
        interval: 20,
      })
      const ready = await fetch(`http://127.0.0.1:${String(port)}/health/ready`)
      expect(ready.status).toBe(503)
      expect(await ready.json()).toEqual({ status: 'shutting-down' })
      child.kill('SIGTERM')
      expect(await exited).toBe(1)
    } finally {
      posthog.hang(0)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 30_000)
})
