/**
 * @file Deletes the Redis keys one SCAN pattern matches, on a raw client of
 * its own: `global-setup.ts` clears every worker's rate-limit counters before
 * a run, and `setup-rate-limits.ts` clears one worker's before each file. A
 * raw client, never `getRedis()`: files that mock `@/services/redis.service`
 * would otherwise break, and a stalled Redis must not hang the hook.
 */
import { createClient } from 'redis'

/**
 * Delete every key matching `pattern`, with SCAN (never KEYS or FLUSHDB: this
 * may be a developer's own Redis). Non-fatal: when Redis is unreachable it
 * warns and resolves, since `SharedRateLimitStore` then falls back to a
 * per-process in-memory store that cannot carry counts across files anyway.
 * @param pattern - The SCAN `MATCH` pattern; scoped to test prefixes by the caller.
 * @param label - Names the caller in the warning.
 * @returns Resolves once the keys are gone or the warning is printed.
 */
export async function clearRedisKeys(pattern: string, label: string): Promise<void> {
  const url = process.env.REDIS_URL
  if (url === undefined) return

  const client = createClient({
    url,
    // Bounded like redis.service.ts's own client: an unbounded connect() would hang the caller instead of falling through to the warning below.
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => (retries > 1 ? new Error('Redis unreachable') : 100),
    },
  })
  // Without a listener, EventEmitter throws node-redis's emitted 'error' and crashes the process.
  client.on('error', () => {})

  try {
    await client.connect()
    const batches = client.scanIterator({ MATCH: pattern, COUNT: 500 })
    for await (const keys of batches) {
      if (keys.length > 0) await client.del(keys)
    }
  } catch (error) {
    console.warn(
      `${label}: could not clear rate-limit counters in Redis; continuing.`,
      (error as Error).message
    )
  } finally {
    if (client.isOpen) client.destroy()
  }
}
