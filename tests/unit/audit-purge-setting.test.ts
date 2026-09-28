/**
 * @file audit_logs' delete trigger only lets a DELETE through inside a
 * transaction that set the purge settings. Asserts that only
 * retention.service.ts names them anywhere under src/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(process.cwd(), 'src')

/**
 * Every TypeScript file under src/ whose text contains `needle`.
 * @param needle - The literal to look for.
 * @returns Repo-relative POSIX paths, sorted.
 */
function sourceFilesNaming(needle: string): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => fs.readFileSync(path.join(SRC, file), 'utf8').includes(needle))
    .map((file) => `src/${file.split(path.sep).join('/')}`)
    .toSorted((a, b) => a.localeCompare(b))
}

describe('the audit purge settings', () => {
  it('are named only by the retention purge', () => {
    expect(sourceFilesNaming('app.audit_purge')).toEqual(['src/services/retention.service.ts'])
  })
})
