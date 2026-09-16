// tests/unit/configs/rate-limit-store.config.test.ts
//
// Pins down Conflict B from the SDD ledger: a rate-limit Store built at
// import time must not resolve its backend eagerly. `getRedis` is mocked
// throughout — no real Redis connection is opened, which is what keeps this
// a tests/unit/ file rather than tests/integration/ (see CLAUDE.md on why a
// Docker-dependent test must never live under tests/unit/). The store's
// behaviour once it IS backed by real Redis is covered separately, against
// the real thing, in tests/integration/.
import { describe, expect, it, vi, type Mock } from 'vitest'
import { SharedRateLimitStore } from '@/configs/rate-limit-store.config'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'

vi.mock('@/services/redis.service', () => ({ getRedis: vi.fn() }))

// SharedRateLimitStore.init() only ever reads `windowMs` off this (directly,
// and indirectly via MemoryStore/RedisStore's own `init`) — every other
// field of the real `Options` type is irrelevant to the store under test.
// `as unknown as` (not a direct `as`) because this literal is nowhere near a
// structural superset of the real, much larger `Options` type.
const testOptions = { windowMs: 60_000 } as unknown as Parameters<SharedRateLimitStore['init']>[0]

/**
 * A minimal fake Redis client: enough to answer the two `SCRIPT LOAD`s
 * `RedisStore.init()` issues and the `EVALSHA` each `increment()` issues,
 * without a real connection. Tracks a real per-key count (rate-limit-redis's
 * own Lua script's `EVALSHA sha 1 <key> <windowMs>` shape — `command[3]` is
 * the key) so a test can assert on the returned `totalHits`, not just on
 * which commands were sent.
 * @returns The fake client and the raw commands it was sent, in order.
 */
function fakeRedisClient(): { client: { sendCommand: Mock }; commands: string[][] } {
  const commands: string[][] = []
  const hits = new Map<string, number>()
  const client = {
    sendCommand: vi.fn((command: string[]) => {
      commands.push(command)
      if (command[0] === 'SCRIPT' && command[1] === 'LOAD') return Promise.resolve('fake-sha')
      if (command[0] === 'EVALSHA') {
        const key = command[3] ?? ''
        const totalHits = (hits.get(key) ?? 0) + 1
        hits.set(key, totalHits)
        return Promise.resolve([totalHits, 60_000])
      }
      return Promise.reject(new Error(`fakeRedisClient: unexpected command ${command.join(' ')}`))
    }),
  }
  return { client, commands }
}

describe('SharedRateLimitStore', () => {
  it('starts on memory, counts hits normally while Redis is unreachable, and warns only once', async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('Redis unreachable'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = new SharedRateLimitStore('rl:test:')
    store.init(testOptions)

    // MemoryStore.increment() returns the SAME mutable record on every call
    // for one key (it mutates `totalHits` in place rather than returning a
    // snapshot) — read `.totalHits` out to a primitive immediately after
    // each call, or all three variables would alias the one final value.
    const firstResult = await store.increment('client-a')
    const firstHits = firstResult.totalHits
    const secondResult = await store.increment('client-a')
    const secondHits = secondResult.totalHits
    const thirdResult = await store.increment('client-a')
    const thirdHits = thirdResult.totalHits

    expect([firstHits, secondHits, thirdHits]).toEqual([1, 2, 3])
    // Three failed latch attempts, one warning — never one per request.
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps two clients independent on the memory fallback', async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('Redis unreachable'))
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = new SharedRateLimitStore('rl:test:')
    store.init(testOptions)

    await store.increment('client-a')
    await store.increment('client-a')
    const clientB = await store.increment('client-b')

    expect(clientB.totalHits).toBe(1)
  })

  it('decrements and resets a client, delegating to the active backend', async () => {
    vi.mocked(getRedis).mockRejectedValue(new Error('Redis unreachable'))
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = new SharedRateLimitStore('rl:test:')
    store.init(testOptions)

    await store.increment('client-a')
    const afterFirstIncrement = await store.increment('client-a')
    expect(afterFirstIncrement.totalHits).toBe(2)

    await store.decrement('client-a')
    const afterDecrement = await store.increment('client-a')
    expect(afterDecrement.totalHits).toBe(2)

    await store.resetKey('client-a')
    const afterReset = await store.increment('client-a')
    expect(afterReset.totalHits).toBe(1)
  })

  it('switches to a Redis-backed store once getRedis resolves, and does not re-run its setup on later requests', async () => {
    const { client, commands } = fakeRedisClient()
    vi.mocked(getRedis).mockResolvedValue(client as never)
    const store = new SharedRateLimitStore('rl:test:')
    store.init(testOptions)

    const first = await store.increment('client-a')
    expect(first.totalHits).toBe(1)
    expect(commands.some((command) => command[0] === 'SCRIPT')).toBe(true)

    commands.length = 0
    const second = await store.increment('client-a')
    expect(second.totalHits).toBe(2)
    // The Lua scripts are loaded once, at the switch — a second request must
    // not re-run RedisStore.init() (which would mean re-attempting the
    // latch on every request instead of switching at most once).
    expect(commands.some((command) => command[0] === 'SCRIPT')).toBe(false)
    expect(commands.some((command) => command[0] === 'EVALSHA')).toBe(true)
  })

  it('does not fall back to memory once latched: a later getRedis rejection surfaces as a store error, not a second fallback', async () => {
    const { client } = fakeRedisClient()
    let isRedisUp = true
    vi.mocked(getRedis).mockImplementation(() =>
      isRedisUp
        ? Promise.resolve(client as never)
        : Promise.reject(new Error('Redis client is closed; the process is shutting down'))
    )
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = new SharedRateLimitStore('rl:test:')
    store.init(testOptions)

    await store.increment('client-a')
    isRedisUp = false

    await expect(store.increment('client-a')).rejects.toThrow(/closed/)
    // No fallback warning: the store never re-attempts the latch, and
    // getRedis() rejecting post-shutdown must not be treated as "back to
    // memory" — it is surfaced as the request failure it is.
    expect(warn).not.toHaveBeenCalled()
  })
})
