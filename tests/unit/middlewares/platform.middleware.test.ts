/**
 * @file requirePlatformRole compares the caller's platform role with its
 * floor: staff below the floor get the same generic 404 as non-staff, and
 * an admitted caller is marked on `response.locals`. logStaffWrites logs
 * only a write the gate admitted, and refusePlatformOptions answers every
 * OPTIONS with the generic 404.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import {
  logStaffWrites,
  refusePlatformOptions,
  requirePlatformRole,
} from '@/middlewares/platform.middleware'
import { logger } from '@/services/logger.service'
import { getPlatformMembership } from '@/services/platform.service'

vi.mock('@/services/platform.service', () => ({ getPlatformMembership: vi.fn() }))

const lookup = vi.mocked(getPlatformMembership)

async function run(
  minimum: MembershipRole,
  platformRole: MembershipRole | null,
  locals: Record<string, unknown> = {}
): Promise<unknown[][]> {
  lookup.mockResolvedValueOnce(platformRole)
  const next = vi.fn()
  const request = { user: { id: 'user-1' } } as unknown as Request
  await requirePlatformRole(minimum)(
    request,
    { locals } as unknown as Response,
    next as NextFunction
  )
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

  it('admits an admin at an admin floor, and marks the response admitted', async () => {
    const locals: Record<string, unknown> = {}
    const calls = await run('admin', 'admin', locals)

    expect(calls).toEqual([[]])
    expect(locals).toEqual({ isPlatformRoleAdmitted: true })
  })

  it('leaves a refused response unmarked', async () => {
    const locals: Record<string, unknown> = {}
    await run('admin', 'viewer', locals)

    expect(locals).toEqual({})
  })
})

const TARGET_ID = '0b9c8f36-3c55-4d7e-9a0f-2f3c1d5e6a7b'

/**
 * Run logStaffWrites over a fake request and a response that finishes with `status`.
 * @param method - The request method.
 * @param status - The status the response finishes with.
 * @param isAdmitted - Whether the role gate marked the response.
 * @param originalUrl - The request path and query.
 * @returns The 'Staff write' calls logged.
 */
function logged(
  method: string,
  status: number,
  isAdmitted: boolean,
  originalUrl = `/api/v1/platform/users/${TARGET_ID}/reactivate?x=1`
): unknown[][] {
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
  const request = {
    method,
    originalUrl,
    user: { id: 'actor-1' },
  } as unknown as Request
  const finishListeners: (() => void)[] = []
  // Only what logStaffWrites touches: `on('finish')`, the status and `locals`.
  const response = {
    statusCode: status,
    locals: isAdmitted ? { isPlatformRoleAdmitted: true } : {},
    on(event: string, listener: () => void) {
      if (event === 'finish') finishListeners.push(listener)
    },
  } as unknown as Response
  const next = vi.fn()

  logStaffWrites(request, response, next as NextFunction)
  for (const listener of finishListeners) listener()

  expect(next).toHaveBeenCalledOnce()
  const calls = info.mock.calls.filter(([message]) => message === 'Staff write')
  info.mockRestore()
  return calls
}

describe('logStaffWrites', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('logs an admitted, successful %s', (method) => {
    expect(logged(method, 200, true)).toEqual([
      [
        'Staff write',
        {
          method,
          path: `/api/v1/platform/users/${TARGET_ID}/reactivate`,
          status: 200,
          actorId: 'actor-1',
          targetType: 'user',
          targetId: TARGET_ID,
        },
      ],
    ])
  })

  it.each([
    ['tenants', 'suspend', 'tenant'],
    ['emails', 'resend', 'email_message'],
    ['email-suppressions', 'lift', 'email_suppression'],
  ])('names a /platform/%s/:id target as %s → %s', (collection, verb, targetType) => {
    const [call] = logged('POST', 202, true, `/api/v1/platform/${collection}/${TARGET_ID}/${verb}`)
    expect(call?.[1]).toMatchObject({ targetType, targetId: TARGET_ID })
  })

  it('logs nothing for a write the role gate did not admit, even a 2xx', () => {
    expect(logged('POST', 200, false)).toEqual([])
  })

  it.each(['OPTIONS', 'GET', 'HEAD', 'TRACE'])('logs nothing for %s, even admitted', (method) => {
    expect(logged(method, 200, true)).toEqual([])
  })

  it('logs nothing for an admitted write that failed', () => {
    expect(logged('POST', 409, true)).toEqual([])
  })

  it('never logs the flag exposure report, which is telemetry', () => {
    expect(logged('POST', 204, true, '/api/v1/platform/me/flags/exposures')).toEqual([])
    expect(logged('POST', 204, true, '/api/v1/platform/me/flags/exposures?x=1')).toEqual([])
  })

  it('exempts only POST on that exact path', () => {
    expect(logged('PUT', 204, true, '/api/v1/platform/me/flags/exposures')).toHaveLength(1)
    expect(logged('POST', 204, true, '/api/v1/platform/me/flags/exposures/extra')).toHaveLength(1)
  })
})

describe('refusePlatformOptions', () => {
  it('answers OPTIONS with the generic 404', () => {
    const next = vi.fn()
    refusePlatformOptions({ method: 'OPTIONS' } as Request, {} as Response, next as NextFunction)

    expect(next.mock.calls[0]?.[0]).toMatchObject({ message: 'Not found', statusCode: 404 })
  })

  it('passes every other method on', () => {
    const next = vi.fn()
    refusePlatformOptions({ method: 'POST' } as Request, {} as Response, next as NextFunction)

    expect(next.mock.calls).toEqual([[]])
  })
})
