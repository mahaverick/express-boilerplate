/**
 * @file The rate-limit store every limiter uses: shared through Redis when it
 * is reachable, per-process in memory when it is not.
 */
import { MemoryStore, type IncrementResponse, type Options, type Store } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'

/**
 * A rate-limit `Store` that starts in memory, switches once to Redis, and falls back to memory per command while Redis fails.
 *
 * Limiters are built before anything connects Redis, so a store that picked
 * its backend at construction would stay per-process for life, letting N
 * replicas allow N times the limit. The first `increment()` whose
 * `getRedis()` resolves and whose Lua scripts load switches to Redis; a
 * failed attempt stays on memory and retries on the next request, which
 * until then pays `getRedis()`'s bounded connect attempt. Every Redis
 * command asks `getRedis()` for the current client, so after `closeRedis()`
 * commands fail instead of reopening a socket. A failed command falls back
 * to memory for that call, logged once per outage: an outage neither 500s
 * limited routes nor turns limiting off (`passOnStoreError` stays unset),
 * at the cost of per-process counting while Redis is down.
 */
export class SharedRateLimitStore implements Store {
  private readonly memory = new MemoryStore()
  private redis: RedisStore | undefined
  private latching: Promise<void> | undefined
  private loggedFallback = false
  private isInOutage = false
  private options: Options | undefined

  /**
   * @param prefix - Prepended to every Redis key so two limiters never
   *   collide. Also the `Store` interface's `prefix`, which express-rate-limit's
   *   validations read to tell limiters apart.
   */
  constructor(public readonly prefix: string) {}

  /**
   * Attempt the one-time switch to a Redis-backed store, sharing one in-flight attempt between concurrent callers.
   */
  private async latchOntoRedisIfReady(): Promise<void> {
    this.latching ??= this.tryLatch()
    await this.latching
  }

  /**
   * The actual latch attempt: switch to Redis once it is reachable, or stay on memory and log once.
   */
  private async tryLatch(): Promise<void> {
    try {
      await getRedis()
    } catch {
      if (!this.loggedFallback) {
        logger.warn('Redis is not reachable yet; falling back to an in-memory rate-limit store')
        this.loggedFallback = true
      }
      // Allow a later call to retry: nothing has latched yet.
      this.latching = undefined
      return
    }

    const redisStore = new RedisStore({
      prefix: this.prefix,
      sendCommand: async (...command: string[]) => {
        const client = await getRedis()
        return client.sendCommand(command)
      },
    })
    try {
      // Loads the scripts: fails while the client reconnects, and must not stay latched as a failure.
      if (this.options) await redisStore.init(this.options)
    } catch (error) {
      this.enterOutage(error)
      this.latching = undefined
      return
    }
    this.redis = redisStore
  }

  /**
   * Log the start of an outage once, however many commands fail during it.
   * @param error - The failure that revealed the outage.
   */
  private enterOutage(error: unknown): void {
    if (this.isInOutage) return
    this.isInOutage = true
    logger.warn('Redis rate-limit command failed; counting per process until Redis recovers', {
      prefix: this.prefix,
      error,
    })
  }

  /**
   * Log the end of an outage once, when the first Redis command succeeds after it.
   */
  private leaveOutage(): void {
    if (!this.isInOutage) return
    this.isInOutage = false
    logger.info('Redis rate-limit store recovered; counting is shared again', {
      prefix: this.prefix,
    })
  }

  /**
   * Run one operation on Redis once switched, falling back to memory when the Redis command fails.
   * @param onRedis - The operation against the Redis-backed store.
   * @param onMemory - The same operation against the in-memory store.
   * @returns The Redis result, or the memory result during an outage.
   */
  private async withFallback<T>(
    onRedis: (store: RedisStore) => Promise<T>,
    onMemory: () => Promise<T> | T
  ): Promise<T> {
    if (!this.redis) return onMemory()
    try {
      const result = await onRedis(this.redis)
      this.leaveOutage()
      return result
    } catch (error) {
      this.enterOutage(error)
      return onMemory()
    }
  }

  /**
   * Initialise the in-memory backend and keep the options for the Redis backend's own init.
   * @param options - The limiter's resolved options.
   */
  init(options: Options): void {
    this.options = options
    this.memory.init(options)
  }

  /**
   * Increment a client's hit counter, first attempting the one-time switch to Redis.
   * @param key - The identifier for a client, as produced by the limiter's `keyGenerator`.
   * @returns The client's updated hit count and reset time.
   */
  async increment(key: string): Promise<IncrementResponse> {
    await this.latchOntoRedisIfReady()
    return this.withFallback(
      (store) => store.increment(key),
      () => this.memory.increment(key)
    )
  }

  /**
   * Decrement a client's hit counter. One that straddles an outage boundary
   * lands on the other backend, so the count errs high (conservative).
   * @param key - The identifier for a client.
   */
  async decrement(key: string): Promise<void> {
    await this.withFallback(
      (store) => store.decrement(key),
      () => this.memory.decrement(key)
    )
  }

  /**
   * Reset a client's hit counter in both backends, so a count taken during an outage is cleared too.
   * @param key - The identifier for a client.
   */
  async resetKey(key: string): Promise<void> {
    await this.memory.resetKey(key)
    await this.withFallback(
      (store) => store.resetKey(key),
      () => {}
    )
  }
}
