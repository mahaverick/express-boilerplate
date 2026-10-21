/**
 * @file `.gitignore` keeps every per-machine `.env*.local` file out of git
 * while the committed `.env.example` and `.env.test` stay tracked.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vite-plus/test'

/**
 * Exit status of `git check-ignore -q` for one path.
 * @param file - The path, relative to the repository root.
 * @returns 0 when ignored, 1 when not.
 */
const checkIgnore = (file: string): number | null =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- a test that reads the developer's own clone with the git on their PATH
  spawnSync('git', ['check-ignore', '-q', file], { cwd: process.cwd() }).status

describe('.gitignore env files', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.production.local',
    '.env.qa.local',
    '.env.staging.local',
    '.env.test.local',
  ])('ignores %s', (file) => {
    expect(checkIgnore(file)).toBe(0)
  })

  it.each(['.env.example', '.env.test'])('does not ignore %s', (file) => {
    expect(checkIgnore(file)).toBe(1)
  })
})
