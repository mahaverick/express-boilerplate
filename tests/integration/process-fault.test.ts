/**
 * @file An uncaught exception in a real `src/index.ts` process: the child
 * reports it to a fake PostHog before it exits 1, and boot raised V8's stack
 * depth to `ERROR_FRAME_LIMIT` first. The child's database and Redis point
 * at port 1, so it reaches no shared service; `tests/helpers/process-fault-preload.ts`
 * throws once boot has installed its listener. What the event carries beyond
 * its capture point is the reporter's.
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
          env: {
            ...process.env,
            APP_PORT: String(await freePort()),
            DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
            REDIS_URL: 'redis://127.0.0.1:1',
            WORKER_ENABLED: 'false',
            POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
            POSTHOG_HOST: posthog.url,
            ERROR_TRACKING_ENABLED: 'true',
            SHUTDOWN_TIMEOUT_MS: '5000',
          },
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
})
