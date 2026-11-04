/**
 * @file Only helpers.controller.ts touches the refresh cookie directly, or
 * reads its spec through `currentRefreshCookie`. Every
 * other controller goes through `presentedRefreshToken`,
 * `deliverRefreshToken` and `clearPresentedRefreshToken`, which pick the
 * cookie or the body by client kind, so a direct call would hand a native app
 * a cookie or read a browser's cookie on a native request.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

const CONTROLLERS = path.resolve(process.cwd(), 'src/controllers')

const HELPERS = 'helpers.controller.ts'

const BANNED_CALLS = ['setRefreshTokenCookie(', 'readRefreshTokenCookie(', 'currentRefreshCookie(']

/**
 * The TypeScript files directly under src/controllers/.
 * @returns Their file names, sorted.
 */
function controllerFiles(): string[] {
  return fs
    .readdirSync(CONTROLLERS)
    .filter((file) => file.endsWith('.ts'))
    .toSorted((a, b) => a.localeCompare(b))
}

/**
 * Every line of a controller file that calls a banned cookie function.
 * @param file - The file name under src/controllers/.
 * @returns One `file:line: text` entry per offending line.
 */
function bannedCallsIn(file: string): string[] {
  const lines = fs.readFileSync(path.join(CONTROLLERS, file), 'utf8').split('\n')
  return lines.flatMap((text, index) =>
    BANNED_CALLS.some((call) => text.includes(call))
      ? [`src/controllers/${file}:${index + 1}: ${text.trim()}`]
      : []
  )
}

describe('direct refresh cookie calls', () => {
  it('scans the controllers, helpers included', () => {
    const files = controllerFiles()

    expect(files.length).toBeGreaterThan(1)
    expect(files).toContain(HELPERS)
    // The helpers call every banned function, so a scan that finds each there reads real source.
    const inHelpers = bannedCallsIn(HELPERS)
    for (const call of BANNED_CALLS) {
      expect(inHelpers.some((line) => line.includes(call))).toBe(true)
    }
  })

  it('appear in no controller but helpers.controller.ts', () => {
    const offending = controllerFiles()
      .filter((file) => file !== HELPERS)
      .flatMap((file) => bannedCallsIn(file))

    expect(offending).toEqual([])
  })
})
