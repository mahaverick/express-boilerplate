/**
 * @file The list cursor's refusal: one 400 for every way a cursor can be
 * wrong, so a client restarts from the first page whatever happened to it.
 */
import { HttpError } from '@/errors/http-error'

/**
 * The stable code a client branches on to drop its cursor and reload the first page.
 */
export const CURSOR_INVALID_CODE = 'CURSOR_INVALID'

/**
 * What a refused cursor answers, as the message and as `errors.cursor`.
 */
const CURSOR_INVALID_MESSAGE = 'This list link is out of date. Reload the list from its first page.'

/**
 * A cursor that is oversize, unsigned, tampered with, from another version,
 * or issued under another sort, search or filter. The body is the
 * validation 400's (`errors.cursor`), plus `code: 'CURSOR_INVALID'`.
 */
export class InvalidCursorError extends HttpError {
  constructor() {
    super(CURSOR_INVALID_MESSAGE, 400, CURSOR_INVALID_CODE, { cursor: [CURSOR_INVALID_MESSAGE] })
    this.name = 'InvalidCursorError'
  }
}
