/**
 * @file The bound on a status section's read. A stalled Redis answers
 * nothing and node-redis stops timing a command once it is written, so
 * the staff status endpoint, which people open during an incident, needs its
 * own deadline.
 */
import { STATUS_READ_TIMEOUT_MS } from '@/constants/platform.constants'
import { logger } from '@/services/logger.service'

/**
 * Wait for a status read, at most `STATUS_READ_TIMEOUT_MS`. A read that has
 * not settled by then is abandoned (its later outcome is ignored) and the
 * fallback is returned, with one `warn` that carries `section` (the label)
 * and `timeoutMs` as fields. A read that rejects still rejects,
 * for the caller's own handling. The timer is cleared on every path and does
 * not keep the process alive.
 * @param read - The read in flight.
 * @param fallback - What the section reports when the read is abandoned.
 * @param label - What was being read, for the warning.
 * @returns The read's value, or the fallback.
 */
export async function withStatusTimeout<T>(
  read: Promise<T>,
  fallback: T,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `${label} did not answer in ${String(STATUS_READ_TIMEOUT_MS)} ms; reporting without them`,
        { section: label, timeoutMs: STATUS_READ_TIMEOUT_MS }
      )
      resolve(fallback)
    }, STATUS_READ_TIMEOUT_MS)
    timer.unref()
  })
  try {
    return await Promise.race([read, deadline])
  } finally {
    clearTimeout(timer)
  }
}
