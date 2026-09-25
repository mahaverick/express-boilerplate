// tests/unit/index.test.ts
//
// index.ts is signal wiring and excluded from coverage, so this proves the
// one thing a unit test of assertEnvConsistent cannot: that boot runs it,
// and exits 1 before anything starts. The child's database and Redis point
// at port 1, so even a regression that let it boot reaches no shared service.
// Its otherwise-valid base env is this process's: the test env that
// tests/helpers/setup-global.ts loaded (.env.test.local, then .env.test).
// VITEST is inherited too, so the child never loads a developer's .env.
// APP_PORT=70000 makes listen() throw ERR_SOCKET_BAD_PORT, which also exits
// 1, so the stderr check below is what proves boot stopped before listening.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('index.ts boot checks', () => {
  it('refuses to boot with a renamed variable, printing the new name and exiting 1', async () => {
    // A clean exit leaves `failure` empty, so the code assertion fails.
    let failure: { code?: number; stderr?: string } = {}
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        env: {
          ...process.env,
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
    expect(failure.stderr).toContain('QUEUE_PREFIX was renamed to REDIS_KEY_PREFIX')
    expect(failure.stderr).not.toContain('ERR_SOCKET_BAD_PORT')
  })
})
