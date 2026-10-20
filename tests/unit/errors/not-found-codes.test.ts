/**
 * @file Every 404 the API throws carries a stable `code`, so the frontends
 * map it to their own copy instead of showing the raw message, and every
 * message follows the copy rules (short, with the next step). The gate parses
 * `src/` and fails on any `new HttpError(…, 404)` or `super(…, 404)` that
 * passes no code, and on any `parseIdParameter` call that names no 404.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { NOT_FOUND } from '@/errors/not-found-errors'

const SOURCE_ROOT = path.resolve(process.cwd(), 'src')

/**
 * Every `.ts` file under a directory.
 * @param directory - Where to start.
 * @returns The absolute paths.
 */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/**
 * Whether a call's status argument is a 404.
 * @param argument - The second argument of the call, if any.
 * @returns True for the literal 404.
 */
function isNotFoundStatus(argument: ts.Expression | undefined): boolean {
  return argument !== undefined && ts.isNumericLiteral(argument) && argument.text === '404'
}

/**
 * Each codeless 404 in `src/`, as `file:line`.
 * @returns The offending sites.
 */
function codelessNotFounds(): string[] {
  const offenders: string[] = []
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    /**
     * Record `node` when it builds a 404 without a code.
     * @param node - The node to check, then its children.
     */
    const visit = (node: ts.Node): void => {
      const isHttpError = ts.isNewExpression(node) && node.expression.getText() === 'HttpError'
      const isSuper =
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword
      const isIdParameter =
        ts.isCallExpression(node) && node.expression.getText() === 'parseIdParameter'
      const callArguments =
        ts.isNewExpression(node) || ts.isCallExpression(node) ? (node.arguments ?? []) : []
      const isMissingCode =
        ((isHttpError || isSuper) &&
          isNotFoundStatus(callArguments[1]) &&
          callArguments[2] === undefined) ||
        (isIdParameter && callArguments.length < 2)
      if (isMissingCode) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        offenders.push(`${path.relative(process.cwd(), file)}:${String(line + 1)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return offenders
}

describe('404 codes', () => {
  it('gives every 404 in src/ a code', () => {
    expect(codelessNotFounds()).toEqual([])
  })

  it.each(Object.entries(NOT_FOUND))(
    'answers %s with a snake_case code and a short message that ends in a next step',
    (_kind, { code, message }) => {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
      expect(message.split(/\s+/).length).toBeLessThan(30)
      expect(message).toMatch(/\.$/)
      // At least two sentences: what happened, then what to do.
      expect(message.split('. ').length).toBeGreaterThanOrEqual(2)
    }
  )
})
