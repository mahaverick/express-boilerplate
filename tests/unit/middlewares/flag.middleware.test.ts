/**
 * @file requireFlag over a mocked evaluation: the expected value admits,
 * any other answers the unknown-route 404, `shouldBeOn = false` inverts the
 * gate, a tenant-scoped flag with no principal answers 404 and logs
 * `flag_gate_no_tenant` without evaluating, and the handler carries its mark.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { evaluateForRequest } from '@/middlewares/flag-context.middleware'
import { FLAG_GATE_MARK, requireFlag } from '@/middlewares/flag.middleware'
import { logger } from '@/services/logger.service'
import type { RequestPrincipal } from '@/types/actor'
import type { FlagEvaluation } from '@/types/flags'

vi.mock('@/middlewares/flag-context.middleware', () => ({ evaluateForRequest: vi.fn() }))

const evaluate = vi.mocked(evaluateForRequest)

const PRINCIPAL: RequestPrincipal = {
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  isPlatformTenant: false,
  role: 'viewer',
  memberRole: 'viewer',
  // eslint-disable-next-line unicorn/no-null -- the principal's contract is `MembershipRole | null`
  platformRole: null,
  access: 'member',
}

/**
 * Run the beta gate once.
 * @param isOn - What the evaluation answers.
 * @param options - The value the gate admits and whether the request has a principal.
 * @param options.shouldBeOn - The value the gate admits.
 * @param options.hasPrincipal - Whether `resolveTenant` ran.
 * @returns The arguments `next` was called with.
 */
async function run(
  isOn: boolean,
  options: { shouldBeOn?: boolean; hasPrincipal?: boolean } = {}
): Promise<unknown[][]> {
  const evaluation: FlagEvaluation = { value: isOn, reason: 'condition_match', conditionIndex: 0 }
  evaluate.mockResolvedValueOnce(evaluation)
  const request = (options.hasPrincipal === false
    ? {}
    : { principal: PRINCIPAL }) as unknown as Request
  const next = vi.fn()
  await requireFlag('example_beta_page', options.shouldBeOn)(
    request,
    {} as Response,
    next as NextFunction
  )
  return next.mock.calls
}

afterEach(() => {
  evaluate.mockReset()
  vi.restoreAllMocks()
})

describe('requireFlag', () => {
  it('admits when the flag is on', async () => {
    expect(await run(true)).toEqual([[]])
  })

  it('answers the unknown-route 404 when the flag is off', async () => {
    const [[error]] = (await run(false)) as [[unknown]]

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ message: 'Not found', statusCode: 404 })
  })

  it('inverts with shouldBeOn = false', async () => {
    expect(await run(false, { shouldBeOn: false })).toEqual([[]])
    const [[error]] = (await run(true, { shouldBeOn: false })) as [[unknown]]
    expect(error).toMatchObject({ statusCode: 404 })
  })

  it('refuses a tenant-scoped flag with no principal, logs it, and never evaluates', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const [[refused]] = (await run(true, { hasPrincipal: false })) as [[unknown]]

    expect(refused).toMatchObject({ message: 'Not found', statusCode: 404 })
    expect(error).toHaveBeenCalledWith('flag_gate_no_tenant', { flag: 'example_beta_page' })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('forwards an evaluation failure to next', async () => {
    const failure = new Error('database down')
    evaluate.mockRejectedValueOnce(failure)
    const next = vi.fn()

    await requireFlag('example_beta_page')(
      { principal: PRINCIPAL } as unknown as Request,
      {} as Response,
      next as NextFunction
    )

    expect(next).toHaveBeenCalledWith(failure)
  })

  it('answers the unknown-route 404, not its own, when the user was deleted since requireAuth', async () => {
    evaluate.mockRejectedValueOnce(new HttpError('User not found', 404))
    const next = vi.fn()

    await requireFlag('example_beta_page')(
      { principal: PRINCIPAL } as unknown as Request,
      {} as Response,
      next as NextFunction
    )

    const [[error]] = next.mock.calls as [[HttpError]]
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ message: 'Not found', statusCode: 404 })
  })

  it('marks its handler with the key and the value that admits', () => {
    expect(requireFlag('example_beta_page', false)[FLAG_GATE_MARK]).toEqual({
      key: 'example_beta_page',
      shouldBeOn: false,
    })
  })
})
