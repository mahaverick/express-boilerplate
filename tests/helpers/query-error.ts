// tests/helpers/query-error.ts
//
// A failed-query error as the ORM builds one: its message embeds the bound
// parameters, and it carries them again as `params`. A log call that passes
// such an error through raw writes the parameters to the log.
import { inspect } from 'node:util'
import type { MockInstance } from 'vitest'

/**
 * The bound parameter a test must never find in a log payload.
 */
export const LEAKED_PARAM = 'secret'

/**
 * A query error whose message and `params` both carry `LEAKED_PARAM`.
 * @returns The error.
 */
export function fakeQueryError(): Error {
  return Object.assign(new Error(`Failed query: select $1\nparams: ${LEAKED_PARAM}`), {
    query: 'select $1',
    params: [LEAKED_PARAM],
  })
}

/**
 * Everything a logger spy was called with, printed in full. `inspect`, not
 * `JSON.stringify`: an Error's message and stack are not enumerable, so
 * `JSON.stringify` would drop the very text that leaks.
 * @param spy - The spied logger method.
 * @returns The printed calls.
 */
export function loggedText(spy: MockInstance): string {
  return inspect(spy.mock.calls, { depth: Infinity })
}
