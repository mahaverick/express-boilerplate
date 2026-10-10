/**
 * @file A stalled Redis for tests: a command that never settles, the way
 * node-redis behaves once a command is written to a server that is
 * connected and does not answer, and a bound that tells "answered after the
 * deadline" from "hung".
 */
import { REDIS_REQUEST_DEADLINE_MS } from '@/constants/platform.constants'
import { settle } from './timing'

/**
 * How long a caller of a stalled Redis may take: well past
 * `REDIS_REQUEST_DEADLINE_MS`, well short of anything that hangs.
 */
const STALL_ANSWER_BOUND_MS = REDIS_REQUEST_DEADLINE_MS * 5

/**
 * A Redis command on a stalled server.
 * @returns A promise that never settles.
 */
export function stalledCommand(): Promise<never> {
  return new Promise<never>(() => {})
}

/**
 * Await an operation, or report that it was still pending after `STALL_ANSWER_BOUND_MS`.
 * @param operation - The operation under test.
 * @returns Its value, or `'hung'`.
 */
export async function answerWithinBound<T>(operation: Promise<T>): Promise<T | 'hung'> {
  const timedOut = (async () => {
    await settle(STALL_ANSWER_BOUND_MS, 'hang budget: a pending operation has no event')
    return 'hung' as const
  })()
  return Promise.race([operation, timedOut])
}
