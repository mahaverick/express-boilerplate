// src/configs/rate-limit-store.config.ts
//
// A rate limiter is built by `createRateLimiter(...)`
// (rate-limit.middleware.ts) the moment `createAuthRouter()` assembles the
// auth routes — which happens before the startup sequence has connected
// anything. Nothing in this codebase connects Redis eagerly:
// `redis.service.ts`'s own header comment says connection is
// lazy, created on first use, precisely so importing a module that
// transitively reaches it never opens a socket. A rate-limit Store that
// resolved its backend at CONSTRUCTION time would therefore be pinned to the
// in-memory `MemoryStore` fallback for the entire life of the process — and
// an in-memory counter is per-process, so with N replicas behind a load
// balancer a limiter configured for "5 attempts" would actually allow
// "5 x N", non-deterministically, depending on which replica happened to
// serve which request.
//
// SharedRateLimitStore instead LATCHES: every instance starts on
// `MemoryStore`, and the first `increment()` whose `getRedis()` resolves and
// whose Lua scripts load makes a Redis-backed store its primary backend from
// then on (a failed script load leaves it unlatched, to retry on the next
// request). It never calls `getRedis()` again from the latch path itself
// once switched — only `sendCommand` does, per actual Redis command, and
// ALWAYS by asking `getRedis()` for the CURRENT client rather than holding
// one captured at latch time. That is what makes shutdown safe without any
// special-casing here: `redis.service.ts`'s `getRedis()` throws once
// `closeRedis()` has run, deliberately refusing to reopen a socket during
// shutdown (see that file's header comment) — routing every command through
// `getRedis()` means this store inherits that guarantee for free instead of
// re-implementing "don't resurrect a connection" against a client reference
// of its own.
//
// One cost worth naming: until the first successful latch, EVERY request
// pays `getRedis()`'s bounded connection attempt when Redis is unreachable
// (the same cost `/health/ready` already pays — see redis.service.ts's
// `reconnectStrategy`: a 5s connect timeout, up to a few hundred ms of
// backoff between retries, giving up after 3). That is the trade for never
// blocking the module-import path on a network call.
//
// After the switch, a Redis command that fails (an outage, or a closed client
// during shutdown) falls back to this store's own MemoryStore for that call,
// as does a failed switch. It is logged once per outage, and the store goes
// back to Redis as soon as a command succeeds. A Redis outage must neither 500 every limited route nor switch
// limiting off (`passOnStoreError`). The cost is per-process counting while
// Redis is down.
import { MemoryStore, type IncrementResponse, type Options, type Store } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'

/**
 * A rate-limit `Store` that starts in memory, switches once to Redis, and falls back to memory per command while Redis fails.
 */
export class SharedRateLimitStore implements Store {
  private readonly memory = new MemoryStore()
  private redis: RedisStore | undefined
  private latching: Promise<void> | undefined
  private loggedFallback = false
  private isInOutage = false
  private options: Options | undefined

  /**
   * @param prefix - Text prepended to every key once this store is backed by
   *   Redis, so two limiters never collide in one shared keyspace. Passed
   *   straight through to `RedisStore`; `MemoryStore` keeps its own
   *   per-instance map regardless. Also exposed as `this.prefix` (the `Store`
   *   interface's own optional field), which express-rate-limit's built-in
   *   validations read to tell two limiters' keys apart.
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
