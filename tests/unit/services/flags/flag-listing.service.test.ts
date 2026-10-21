/**
 * @file The unregistered flags the lists and the system status share: a key
 * longer than `LISTED_FLAG_KEY_MAX` is left out of both, and one warning per
 * snapshot names it. Redis and the snapshot store are mocks.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LISTED_FLAG_KEY_MAX } from '@/constants/flags.constants'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import { listableUnregisteredFlags } from '@/services/flags/flag-listing.service'
import { logger } from '@/services/logger.service'
import type { ParsedDefinition, ParsedSnapshot } from '@/validators/flag-definition.validators'

const store = vi.hoisted(() => ({ current: undefined as ParsedSnapshot | undefined }))

vi.mock('@/services/flags/flag-snapshot.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/flags/flag-snapshot.service')>()
  // oxlint-disable-next-line unicorn/no-null -- the store answers null before a first load
  return { ...actual, getFlagSnapshot: () => store.current ?? null }
})

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return {
    ...actual,
    getRedis: () =>
      Promise.resolve({
        // oxlint-disable-next-line unicorn/no-null -- Redis answers null for a missing key
        mGet: (keys: string[]) => Promise.resolve(keys.map(() => null)),
      }),
  }
})

/**
 * A snapshot holding flags with the given keys.
 * @param keys - The flag keys.
 * @returns The snapshot.
 */
function snapshotOf(keys: string[]): ParsedSnapshot {
  const flags = Object.fromEntries(
    keys.map((key, index) => [key, { id: index, key, active: true } as ParsedDefinition])
  )
  return {
    etag: 'e',
    fetchedAt: '2026-10-16T00:00:00.000Z',
    checkedAt: '2026-10-16T00:00:00.000Z',
    propertyMatchingVersion: 1,
    tenantGroupIndex: 0,
    fingerprint: 'f',
    flags,
  }
}

const TOO_LONG = 'a'.repeat(LISTED_FLAG_KEY_MAX + 1)

afterEach(() => {
  store.current = undefined
  vi.restoreAllMocks()
})

describe('listableUnregisteredFlags', () => {
  it('leaves out a registered key and a key too long for a cursor', () => {
    const snapshot = snapshotOf(['example_beta_page', 'ok_flag', TOO_LONG])
    vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    expect(listableUnregisteredFlags(snapshot).map((flag) => flag.key)).toEqual(['ok_flag'])
  })

  it('answers nothing without a snapshot', () => {
    // oxlint-disable-next-line unicorn/no-null -- the store answers null before a first load
    expect(listableUnregisteredFlags(null)).toEqual([])
  })

  it('warns once per snapshot, with the length and a prefix, and again for a new one', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const first = snapshotOf([TOO_LONG])

    listableUnregisteredFlags(first)
    listableUnregisteredFlags(first)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too long'), {
      keyLength: LISTED_FLAG_KEY_MAX + 1,
      keyPrefix: 'a'.repeat(40),
    })
    listableUnregisteredFlags(snapshotOf([TOO_LONG]))
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('the system status unregistered count', () => {
  it('counts the same flags the lists hold, a too-long key excluded', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    store.current = snapshotOf(['ok_one', 'ok_two', TOO_LONG])

    const status = await getFlagsStatus()

    expect(status.counts.unregistered).toBe(2)
  })
})
