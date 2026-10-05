/**
 * @file The per-request flag helpers, with the context reader and the
 * service mocked: the context is read once per request from the user, the
 * resolved tenant and the session, and each key is evaluated once.
 */
import type { Request } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateForRequest, flagContextFor } from '@/middlewares/flag-context.middleware'
import { flagContextForUser } from '@/services/flags/flag-context.service'
import { evaluateKey } from '@/services/flags/flags.service'
import type { FlagContext } from '@/types/flags'

vi.mock('@/services/flags/flag-context.service', () => ({ flagContextForUser: vi.fn() }))
vi.mock('@/services/flags/flags.service', () => ({ evaluateKey: vi.fn() }))

// eslint-disable-next-line unicorn/no-null -- the context's contract uses null
const NONE = null
const USER_ID = '0199b000-0000-7000-8000-000000000001'
const TENANT_ID = '0199b000-0000-7000-8000-000000000002'

const CONTEXT: FlagContext = {
  distinctId: USER_ID,
  groups: {},
  personProps: {},
  groupProps: {},
  tenantId: NONE,
  sessionId: NONE,
}

/**
 * A request as the helpers read it.
 * @param fields - The request fields to set.
 * @returns The request.
 */
function requestWith(fields: Record<string, unknown>): Request {
  return fields as unknown as Request
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('flagContextFor', () => {
  it('reads the context once per request, from the user, the resolved tenant and the session', async () => {
    vi.mocked(flagContextForUser).mockResolvedValue(CONTEXT)
    const request = requestWith({
      user: { id: USER_ID },
      principal: { tenantId: TENANT_ID },
      sessionId: 'session-1',
    })

    const first = flagContextFor(request)
    const second = flagContextFor(request)

    expect(second).toBe(first)
    await expect(first).resolves.toBe(CONTEXT)
    expect(flagContextForUser).toHaveBeenCalledOnce()
    expect(flagContextForUser).toHaveBeenCalledWith(USER_ID, TENANT_ID, 'session-1')
  })

  it('reads a tenantless, sessionless context when the request has neither', async () => {
    vi.mocked(flagContextForUser).mockResolvedValue(CONTEXT)
    await flagContextFor(requestWith({ user: { id: USER_ID } }))
    expect(flagContextForUser).toHaveBeenCalledWith(USER_ID, NONE, NONE)
  })

  it('rejects a request that did not pass requireAuth', async () => {
    await expect(flagContextFor(requestWith({}))).rejects.toThrow('requireAuth')
    expect(flagContextForUser).not.toHaveBeenCalled()
  })
})

describe('evaluateForRequest', () => {
  it('evaluates each key once per request', async () => {
    vi.mocked(flagContextForUser).mockResolvedValue(CONTEXT)
    vi.mocked(evaluateKey).mockResolvedValue({
      value: true,
      reason: 'condition_match',
      conditionIndex: 0,
    })
    const request = requestWith({ user: { id: USER_ID } })

    const first = evaluateForRequest(request, 'example_beta_page')
    expect(evaluateForRequest(request, 'example_beta_page')).toBe(first)
    await expect(first).resolves.toEqual({
      value: true,
      reason: 'condition_match',
      conditionIndex: 0,
    })
    await evaluateForRequest(request, 'example_cta_experiment')

    expect(evaluateKey).toHaveBeenCalledTimes(2)
    expect(evaluateKey).toHaveBeenCalledWith(CONTEXT, 'example_beta_page')
    expect(evaluateKey).toHaveBeenCalledWith(CONTEXT, 'example_cta_experiment')
    expect(flagContextForUser).toHaveBeenCalledOnce()
  })
})
