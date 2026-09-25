// tests/unit/public-user-builder.test.ts
//
// Every response that returns a user builds it with toProfileResponse, so it
// carries platformRole. A bare toPublicUser( call outside the presenter
// would ship a user without it; this scan fails first.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(process.cwd(), 'src')
const ALLOWED = new Set(['presenters/user.presenter.ts'])

function sourceFiles(directory = SRC): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [path.relative(SRC, full).split(path.sep).join('/')] : []
  })
}

function callSites(relativePath: string, source: string): string[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text) && /\btoPublicUser\(/.test(text))
    .map(({ line }) => `${relativePath}:${line}`)
}

describe('the client-facing user builder', () => {
  it('calls toPublicUser only inside user.presenter.ts', () => {
    const offenders = sourceFiles()
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => callSites(file, fs.readFileSync(path.join(SRC, file), 'utf8')))

    expect(offenders).toEqual([])
  })

  it('catches a bare call, proven on a known-bad snippet', () => {
    const snippet = "successResponse(response, { user: toPublicUser(user) }, 'ok')"

    expect(callSites('controllers/probe.controller.ts', snippet)).toEqual([
      'controllers/probe.controller.ts:1',
    ])
  })
})
