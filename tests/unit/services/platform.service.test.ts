// tests/unit/services/platform.service.test.ts
//
// The pure domain rules auto-join applies, and how a failed join is logged.
// Importing the service does not touch Postgres: database.service.ts
// connects on first query, and nothing here queries.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import {
  autoJoinSafely,
  isPlatformEmailDomain,
  parsePlatformEmailDomains,
} from '@/services/platform.service'
import { fakeQueryError, LEAKED_PARAM, loggedText } from '../../helpers/query-error'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parsePlatformEmailDomains', () => {
  it('returns no domains for an unset value', () => {
    expect(parsePlatformEmailDomains(undefined)).toEqual([])
  })

  it('splits on commas, trims and lowercases each entry', () => {
    expect(parsePlatformEmailDomains(' staff.example.com , Example.ORG')).toEqual([
      'staff.example.com',
      'example.org',
    ])
  })
})

describe('isPlatformEmailDomain', () => {
  const domains = ['staff.example.com']

  it('matches the exact domain, in any case', () => {
    expect(isPlatformEmailDomain('ada@Staff.Example.COM', domains)).toBe(true)
  })

  it('does not match a subdomain', () => {
    expect(isPlatformEmailDomain('ada@eu.staff.example.com', domains)).toBe(false)
  })

  it('does not match a look-alike that merely ends with the domain', () => {
    expect(isPlatformEmailDomain('ada@evilstaff.example.com', domains)).toBe(false)
  })

  it('matches nothing when the list is empty', () => {
    expect(isPlatformEmailDomain('ada@staff.example.com', [])).toBe(false)
  })
})

describe('autoJoinSafely', () => {
  it('logs a failed join query without its bound parameters', async () => {
    vi.spyOn(db, 'transaction').mockRejectedValue(fakeQueryError())
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const user = { id: 'user-1', email: 'ada@staff.example.com', emailVerifiedAt: new Date() }

    await autoJoinSafely(user, db, ['staff.example.com'])

    expect(warn).toHaveBeenCalledWith(
      'Platform auto-join failed',
      expect.objectContaining({ userId: 'user-1' })
    )
    expect(loggedText(warn)).toContain('paramCount: 1')
    expect(loggedText(warn)).not.toContain(LEAKED_PARAM)
  })
})
