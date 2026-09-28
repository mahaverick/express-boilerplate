/**
 * @file The local/comment-style ESLint rule: every comment is JSDoc, a
 * single-line why, a directive or a one-line JSX comment, and none narrates history.
 */
import { findHistory } from './history-patterns.mjs'

const DIRECTIVE =
  /^\s*(?:eslint-disable|eslint-enable|@ts-(?:expect-error|ignore|nocheck|check)|prettier-ignore|(?:c8|v8|istanbul)\s+ignore|@vite-ignore|webpackChunkName|@vitest-environment|[#@]__PURE__|\/\s*<reference\b)/

/**
 * Whether a block comment is the whole body of a JSX expression container on one line.
 * @param text - The file's source text.
 * @param comment - The comment to test.
 * @returns True for `{/* … *\/}` on a single line.
 */
function isOneLineJsxComment(text, comment) {
  if (comment.loc.start.line !== comment.loc.end.line) return false
  return (
    text.slice(0, comment.range[0]).trimEnd().endsWith('{') &&
    text.slice(comment.range[1]).trimStart().startsWith('}')
  )
}

/**
 * The local/comment-style ESLint rule. See comment-style.d.mts for its type.
 */
export const commentStyleRule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'JSDoc or one-line whys only, and no history in comments.' },
    schema: [],
    messages: {
      notJsdoc: 'Block comments must be JSDoc (/** … */), a directive, or a one-line JSX comment.',
      multiLine:
        "One line per // comment. Put a longer reason in the enclosing declaration's JSDoc.",
      history: 'Comments state what is true now; "{{match}}" narrates history.',
    },
  },
  create(context) {
    const { sourceCode } = context
    return {
      Program() {
        let previous
        for (const comment of sourceCode.getAllComments()) {
          const isDirective = DIRECTIVE.test(comment.value)
          const match = findHistory(comment.value)
          if (match) context.report({ loc: comment.loc, messageId: 'history', data: { match } })
          if (
            !isDirective &&
            comment.type === 'Block' &&
            !comment.value.startsWith('*') &&
            !isOneLineJsxComment(sourceCode.text, comment)
          ) {
            context.report({ loc: comment.loc, messageId: 'notJsdoc' })
          }
          if (
            !isDirective &&
            comment.type === 'Line' &&
            previous?.type === 'Line' &&
            !previous.isDirective &&
            comment.loc.start.line === previous.endLine + 1
          ) {
            context.report({ loc: comment.loc, messageId: 'multiLine' })
          }
          previous = { type: comment.type, isDirective, endLine: comment.loc.end.line }
        }
      },
    }
  },
}
