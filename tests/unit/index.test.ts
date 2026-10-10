/**
 * @file index.ts is signal wiring and excluded from coverage, so this
 * proves the one thing a unit test of assertEnvConsistent cannot: that
 * boot actually calls it and exits 1 before anything starts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('index.ts boot checks', () => {
  /**
   * The spawned child points its database and Redis at port 1, so even
   * a regression that let boot proceed reaches no shared service;
   * APP_PORT=70000 forces a second, later exit path (listen() throwing
   * ERR_SOCKET_BAD_PORT), so the stderr assertion below is what proves
   * boot stopped before that point. A clean exit leaves `failure`
   * empty, so the code assertion fails. QUEUE_PREFIX is a name the
   * schema does not read, so it must not appear in the refusal.
   */
  it('refuses to boot with the flags key but no project key, listing only that problem and exiting 1', async () => {
    let failure: { code?: number; stderr?: string } = {}
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        env: {
          ...process.env,
          POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real',
          QUEUE_PREFIX: 'bull',
          DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
          REDIS_URL: 'redis://127.0.0.1:1',
          WORKER_ENABLED: 'false',
          APP_PORT: '70000',
        },
        timeout: 15_000,
      })
    } catch (error) {
      failure = error as { code?: number; stderr?: string }
    }

    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain(
      'POSTHOG_FEATURE_FLAGS_KEY is set but POSTHOG_PROJECT_KEY is not'
    )
    expect(failure.stderr).not.toContain('QUEUE_PREFIX')
    expect(failure.stderr).not.toContain('ERR_SOCKET_BAD_PORT')
  })
})
