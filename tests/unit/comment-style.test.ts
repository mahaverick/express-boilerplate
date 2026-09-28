import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { commentStyleRule } from '../../scripts/comment-style.mjs'

const linter = new Linter({ configType: 'flat' })

/**
 * Lint a snippet with only the comment-style rule on.
 * @param code - Source text.
 * @param filename - Decides TS or TSX parsing.
 * @returns The messageIds reported, in order.
 */
function lint(code: string, filename = 'file.ts'): (string | undefined)[] {
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts', '**/*.tsx'],
          linterOptions: { reportUnusedDisableDirectives: 'off' },
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { local: { rules: { 'comment-style': commentStyleRule } } },
          rules: { 'local/comment-style': 'error' },
        },
      ],
      { filename }
    )
    .map((message) => message.messageId)
}

describe('local/comment-style', () => {
  it.each([
    ['a JSDoc block', '/** Contract. */\nexport const a = 1\n'],
    ['a file JSDoc', '/** @file What this module is for. */\nexport const a = 1\n'],
    ['a one-line why', 'const a = 1 // the header is stripped upstream\n'],
    [
      'a directive then a why',
      '// eslint-disable-next-line no-console -- CLI output\n// why\nconsole.log(1)\n',
    ],
    ['a block eslint directive', '/* eslint-disable no-console */\nconsole.log(1)\n'],
    ['a triple-slash reference', '/// <reference types="vite/client" />\nexport {}\n'],
    ['a pure annotation', 'export const a = /*#__PURE__*/ f()\n'],
    ['a vitest environment directive', '// @vitest-environment node\n// why\nexport {}\n'],
    ['a multi-line JSDoc', '/**\n * Contract.\n * @returns One.\n */\nexport const a = 1\n'],
    [
      '"previously" for an earlier step of the same runtime flow',
      '/** Unsubscribe a handler previously passed to `onNotification`. */\nexport const a = 1\n',
    ],
    [
      '"previously" across a JSDoc line break',
      '/**\n * `passport.use(name, strategy)` simply overwrites whatever was previously\n * registered under that name.\n */\nexport const a = 1\n',
    ],
  ])('allows %s', (_name, code) => {
    expect(lint(code)).toEqual([])
  })

  it('allows a single-line JSX comment', () => {
    expect(lint('export const v = <div>{/* why */}</div>\n', 'file.tsx')).toEqual([])
  })

  it('rejects a plain block comment', () => {
    expect(lint('/* not JSDoc */\nexport const a = 1\n')).toEqual(['notJsdoc'])
  })

  it('rejects a divider', () => {
    expect(lint('/*** divider ***/\nexport const a = 1\n')).toEqual(['notJsdoc'])
  })

  it('rejects a multi-line JSX comment', () => {
    expect(lint('export const v = <div>{/* one\n two */}</div>\n', 'file.tsx')).toEqual([
      'notJsdoc',
    ])
  })

  it('rejects consecutive line comments', () => {
    expect(lint('// one\n// two\nexport const a = 1\n')).toEqual(['multiLine'])
  })

  it.each([
    ['a task number', '/** Added in Task 3. */\nexport const a = 1\n'],
    ['a brief file', '// see task-3-brief.md\nexport const a = 1\n'],
    ['an audit id', '// M20: nginx headers\nexport const a = 1\n'],
    ['previously', '// previously a cookie\nexport const a = 1\n'],
    [
      'previously-shipped',
      '/** Covers a real, previously-shipped false-negative. */\nexport const a = 1\n',
    ],
  ])('rejects history: %s', (_name, code) => {
    expect(lint(code)).toEqual(['history'])
  })
})
