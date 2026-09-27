// tests/helpers/timing.ts
//
// waitUntil polls an observable condition instead of guessing how long an
// async effect takes. settle is a deliberate real-time wait for the rare
// case where nothing observable stands in for the delay itself; its reason
// argument names that case at each call site. This is the only file under
// tests/ that lint lets wait on real time directly (sleep, a setTimeout
// promise, timers/promises), so every other deliberate wait goes through
// settle here.
import { setTimeout as delay } from 'node:timers/promises'
import { inspect } from 'node:util'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_INTERVAL_MS = 25

/**
 * How one `waitUntil` check ended.
 */
type Attempt<T> = { threw: false; value: T } | { threw: true; error: unknown }

/**
 * Run one check, turning a throw or a rejection into a result.
 * @param check - The condition to evaluate.
 * @returns The value it returned, or the error it threw.
 */
async function attempt<T>(check: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { threw: false, value: await check() }
  } catch (error) {
    return { threw: true, error }
  }
}

/**
 * Poll `check` until it returns a truthy value, and resolve with that value.
 * A check that throws counts as not yet met. A check that never settles is not interrupted.
 * @param check - The condition; called at once, then after every `interval`.
 * @param options - What is awaited and how long to poll.
 * @param options.message - Names the condition; the timeout error starts with it.
 * @param options.timeout - The longest wait in ms (default 5000).
 * @param options.interval - The pause between checks in ms (default 25).
 * @returns The first truthy value `check` returned.
 * @throws {Error} When `timeout` passes first; the message ends with the last value or error.
 */
export async function waitUntil<T>(
  check: () => T | Promise<T>,
  options: { message: string; timeout?: number; interval?: number }
): Promise<NonNullable<T>> {
  const { message, timeout = DEFAULT_TIMEOUT_MS, interval = DEFAULT_INTERVAL_MS } = options
  const deadline = Date.now() + timeout
  let last = await attempt(check)
  while (last.threw || !last.value) {
    if (Date.now() >= deadline) {
      const detail = last.threw
        ? `last error: ${inspect(last.error)}`
        : `last value: ${inspect(last.value)}`
      throw new Error(`${message} (not met within ${String(timeout)}ms; ${detail})`)
    }
    await delay(interval)
    last = await attempt(check)
  }
  return last.value
}

/**
 * Wait `ms` of real time on purpose. Use only when no condition can be observed instead.
 * @param ms - How long to wait.
 * @param reason - Why no condition can replace this wait; a blank reason rejects.
 * @returns Resolves after `ms`.
 * @throws {TypeError} When `reason` is empty or only whitespace.
 */
export async function settle<R extends string>(
  ms: number,
  reason: R & (R extends '' ? never : unknown)
): Promise<void> {
  if (reason.trim() === '') {
    throw new TypeError('settle() needs a reason: name what cannot be observed instead')
  }
  await delay(ms)
}
