// src/configs/rate-limit-store.config.ts
//
// A rate limiter is built by `createLoginRateLimiter()`/
// `createRefreshRateLimiter()` (rate-limit.middleware.ts) the moment
// `createAuthRouter()` assembles the auth routes — which happens before the
// startup sequence has connected anything. Nothing in this codebase connects
// Redis eagerly: `redis.service.ts`'s own header comment says connection is
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
// `MemoryStore`, and the first `increment()` call whose `getRedis()` call
// resolves swaps the active backend to a Redis-backed store for the rest of
// the process. It never calls `getRedis()` again from the latch path itself
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
import { MemoryStore, type IncrementResponse, type Options, type Store } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { getRedis } from '@/services/redis.service'

/**
 * A rate-limit `Store` that starts in memory and switches, at most once, to
 * a Redis-backed store the first time a request finds Redis reachable. See
 * this file's header comment for why resolving the backend any earlier, or
 * re-resolving it after a shutdown, would defeat the point.
 */
export class SharedRateLimitStore implements Store {
  private active: Store = new MemoryStore()
  private latching: Promise<void> | undefined
  private loggedFallback = false
  private options: Options | undefined

  /**
   * @param prefix - Text prepended to every key once this store is backed by
   *   Redis, so two limiters never collide in one shared keyspace. Passed
   *   straight through to `RedisStore`; `MemoryStore` keeps its own,
   *   per-instance map regardless, so the prefix has no effect until the
   *   latch succeeds. Also exposed as `this.prefix` (the `Store` interface's
   *   own optional field), which express-rate-limit's built-in validations
   *   read to tell two limiters' keys apart.
   */
  constructor(public readonly prefix: string) {}

  /**
   * Attempt the one-time switch from `MemoryStore` to a Redis-backed store.
   *
   * The in-flight attempt is cached on `this.latching` rather than guarded
   * by a plain boolean checked-then-set: several requests can call this
   * concurrently before the first one resolves, and without sharing the same
   * promise each would independently call `getRedis()` — reintroducing, from
   * here, the exact duplicate-connection race `redis.service.ts`'s own
   * lazy-connect already has to account for on its first caller. Once
   * `this.latching` resolves it is never cleared, so a later rejection
   * (Redis reachable once, then not) is left to `sendCommand` to surface as
   * an ordinary store error — this method itself never re-attempts.
   */
  private async latchOntoRedisIfReady(): Promise<void> {
    this.latching ??= this.tryLatch()
    await this.latching
  }

  /**
   * The actual latch attempt: resolve once Redis is confirmed reachable and
   * swap `active` to a Redis-backed store, or fall back to logging (once)
   * and leaving `active` on `MemoryStore`.
   */
  private async tryLatch(): Promise<void> {
    try {
      await getRedis()
    } catch {
      if (!this.loggedFallback) {
        console.warn(
          'rate-limit-store: Redis is not reachable yet; falling back to an in-memory rate-limit store'
        )
        this.loggedFallback = true
      }
      // Allow a LATER call to retry: this attempt failed before ever
      // reaching Redis, so nothing here has latched onto anything yet.
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
    if (this.options) await redisStore.init(this.options)
    void this.active.shutdown?.()
    this.active = redisStore
  }

  /**
   * Initialise the currently active backend. Called once by
   * `express-rate-limit` itself, synchronously, when the limiter is built —
   * before any request has arrived, so `active` is still `MemoryStore` here.
   * The options are also kept so a later switch to Redis can initialise
   * THAT backend identically.
   * @param options - The limiter's resolved options.
   */
  init(options: Options): void {
    this.options = options
    void this.active.init?.(options)
  }

  /**
   * Increment a client's hit counter, first attempting the one-time switch
   * to Redis.
   * @param key - The identifier for a client, as produced by the limiter's `keyGenerator`.
   * @returns The client's updated hit count and reset time.
   */
  async increment(key: string): Promise<IncrementResponse> {
    await this.latchOntoRedisIfReady()
    return this.active.increment(key)
  }

  /**
   * Decrement a client's hit counter. The `Store` interface requires this
   * regardless of whether any limiter built from this store actually enables
   * `skipSuccessfulRequests`/`skipFailedRequests`.
   * @param key - The identifier for a client.
   */
  async decrement(key: string): Promise<void> {
    await this.active.decrement(key)
  }

  /**
   * Reset a single client's hit counter.
   * @param key - The identifier for a client.
   */
  async resetKey(key: string): Promise<void> {
    await this.active.resetKey(key)
  }
}
