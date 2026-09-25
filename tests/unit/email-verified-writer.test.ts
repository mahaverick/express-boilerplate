// tests/unit/email-verified-writer.test.ts
//
// markEmailVerified (verification.service.ts) is the one writer of
// users.email_verified_at. This scans src/ so a second writer fails here
// rather than in review. Comment lines are skipped: prose may name the column.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(process.cwd(), 'src')

interface WriterRule {
  name: string
  pattern: RegExp
  allowedIn: readonly string[]
}

// Paths are relative to src/, POSIX separators.
const RULES: readonly WriterRule[] = [
  {
    name: 'an emailVerifiedAt object key (an insert/update value)',
    pattern: /\bemailVerifiedAt\s*:/,
    // The column definition, and the repository primitive markEmailVerified wraps.
    allowedIn: ['database/models/user.model.ts', 'repositories/user.repository.ts'],
  },
  {
    name: 'the raw email_verified_at column name',
    pattern: /\bemail_verified_at\b/,
    allowedIn: ['database/models/user.model.ts'],
  },
  {
    name: 'a call to the repository primitive markEmailVerified',
    pattern: /\.markEmailVerified\(/,
    allowedIn: ['services/verification.service.ts'],
  },
]

/**
 * Lines of a source file that are code, not comment prose.
 * @param source - The file's text.
 * @returns Each non-comment line with its 1-based line number.
 */
function codeLines(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text))
}

/**
 * Every place in one file that breaks a rule.
 * @param relativePath - The file's path relative to src/.
 * @param source - The file's text.
 * @returns One `path:line rule` string per violation.
 */
function violationsIn(relativePath: string, source: string): string[] {
  return RULES.flatMap((rule) =>
    rule.allowedIn.includes(relativePath)
      ? []
      : codeLines(source)
          .filter(({ text }) => rule.pattern.test(text))
          .map(({ line }) => `${relativePath}:${line} ${rule.name}`)
  )
}

/**
 * Every TypeScript source file under src/, relative to it.
 * @returns POSIX-style relative paths.
 */
function sourceFiles(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.startsWith('lint-fixtures/'))
}

describe('users.email_verified_at has one writer', () => {
  it('flags each writer shape it exists to catch (the patterns are not vacuous)', () => {
    const bad = [
      'await userRepository.update(id, { passwordHash, emailVerifiedAt: new Date() })',
      'await sql`update users set email_verified_at = now() where id = ${id}`',
      'await userRepository.markEmailVerified(user.id)',
    ].join('\n')
    expect(violationsIn('controllers/example.controller.ts', bad)).toHaveLength(3)
  })

  it('finds no writer outside markEmailVerified', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsIn(file, fs.readFileSync(path.join(SRC, file), 'utf8'))
    )
    expect(violations).toEqual([])
  })

  it('still has the one allowed writer (a renamed service must update this gate)', () => {
    const service = fs.readFileSync(path.join(SRC, 'services/verification.service.ts'), 'utf8')
    expect(service).toMatch(/\.markEmailVerified\(userId, executor\)/)
  })
})
