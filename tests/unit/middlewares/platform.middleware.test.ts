// tests/unit/middlewares/platform.middleware.test.ts
//
// requirePlatformRole compares the caller's platform role with its floor:
// staff below the floor get the same generic 404 as non-staff.
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import { requirePlatformRole } from '@/middlewares/platform.middleware'
import { getPlatformMembership } from '@/services/platform.service'

vi.mock('@/services/platform.service', () => ({ getPlatformMembership: vi.fn() }))

const lookup = vi.mocked(getPlatformMembership)

async function run(
  minimum: MembershipRole,
  platformRole: MembershipRole | null
): Promise<unknown[][]> {
  lookup.mockResolvedValueOnce(platformRole)
  const next = vi.fn()
  const request = { user: { id: 'user-1' } } as unknown as Request
  await requirePlatformRole(minimum)(request, {} as Response, next as NextFunction)
  return next.mock.calls
}

describe('requirePlatformRole', () => {
  afterEach(() => {
    lookup.mockReset()
  })

  it('refuses a viewer at an admin floor with the generic 404', async () => {
    const calls = await run('admin', 'viewer')
    const error = calls[0]?.[0]

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ message: 'Not found', statusCode: 404 })
    expect(lookup).toHaveBeenCalledWith('user-1')
  })

  it('refuses a non-staff user with the generic 404', async () => {
    // eslint-disable-next-line unicorn/no-null -- getPlatformMembership answers null for non-staff
    const calls = await run('viewer', null)
    const error = calls[0]?.[0]

    expect(error).toMatchObject({ message: 'Not found', statusCode: 404 })
  })

  it('admits an admin at an admin floor', async () => {
    const calls = await run('admin', 'admin')

    expect(calls).toEqual([[]])
  })
})
