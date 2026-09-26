// tests/unit/audit-purge-setting.test.ts
//
// audit_logs' trigger lets a DELETE through only in a transaction that set
// the purge settings. Only the retention purge may set them, so any other
// file under src/ that names them fails here.
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
