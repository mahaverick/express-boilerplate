/**
 * @file An uncaught exception in a real `src/index.ts` process: the child
 * reports it to a fake PostHog before it exits 1, and boot raised V8's stack
 * depth to `ERROR_FRAME_LIMIT` first. The child's database and Redis point
 * at port 1, so it reaches no shared service; `tests/helpers/process-fault-preload.ts`
 * throws once boot has installed its listener. What the event carries beyond
 * its capture point is the reporter's. A second child faults while PostHog
 * holds the report: during that fatal flush it is already out of rotation,
 * and a SIGTERM then still exits 1. Each child binds a port the OS picks
 * (the preload) and prints it; the test never chooses one, so no other
 * process can take it between the choice and the bind.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ERROR_FRAME_LIMIT } from '@/constants/error-tracking.constants'
import { startFakePosthog, type FakePosthog } from '../helpers/fake-posthog'

const execFileAsync = promisify(execFile)
const fake: { posthog?: FakePosthog } = {}

/**
 * The line the preload prints once the child's server listens.
 */
const LISTENING_LINE = /process-fault-preload listening (\d+)/

/**
 * The port a child's server bound, read from the line the preload prints.
 * @param child - A child started with stdout piped.
 * @returns Resolves with the port once the line arrives.
 */
async function listeningPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = LISTENING_LINE.exec(output)
      if (match?.[1] !== undefined) resolve(Number(match[1]))
    })
    child.once('exit', () => reject(new Error('the child exited before it listened')))
  })
}

/**
 * The environment of a child `src/index.ts` that reaches no shared service.
 * `APP_PORT` is 1, a port the child may not bind: the preload replaces it
 * with one the OS picks, and a child that ignored the preload would fail
 * to start rather than race another process for a port.
 * @param posthog - The fake PostHog it reports to.
 * @returns The environment.
 */
function childEnv(posthog: FakePosthog): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_PORT: '1',
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
          env: childEnv(posthog),
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
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', './tests/helpers/process-fault-preload.ts', 'src/index.ts'],
      { env: childEnv(posthog), stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const listening = listeningPort(child)
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
    })
    try {
      const port = await listening
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
