/**
 * @file audit_logs' trigger lets a DELETE or a redacting UPDATE through only
 * inside a transaction that set its settings. Asserts that only the retention
 * purge and the staff purge name them anywhere under src/.
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

describe('the audit purge and redact settings', () => {
  it('are named only by the retention purge and the staff purge', () => {
    expect(sourceFilesNaming('app.audit_purge')).toEqual([
      'src/services/platform-purge.service.ts',
      'src/services/retention.service.ts',
    ])
    expect(sourceFilesNaming('app.audit_redact')).toEqual([
      'src/services/platform-purge.service.ts',
    ])
  })
})
