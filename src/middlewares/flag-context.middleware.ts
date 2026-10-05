/**
 * @file The flag helpers request code uses, since services never see a
 * request: the request's evaluation context, read once, and each flag's
 * evaluation, computed once per request. Both are memoised on the request
 * (`request.flagContext`, `request.flagEvaluations`). Call them after
 * `requireAuth`, and on a tenant route after `resolveTenant`: the first call
 * fixes the tenant the context holds.
 */
import type { Request } from 'express'
import type { FlagKey } from '@/constants/flags.constants'
import { flagContextForUser } from '@/services/flags/flag-context.service'
import { evaluateKey } from '@/services/flags/flags.service'
import type { FlagContext, FlagEvaluation } from '@/types/flags'

/**
 * The request's evaluation context, read once per request from the
 * authenticated user, the tenant `resolveTenant` admitted them to (none
 * outside a tenant route) and the access token's session id.
 * @param request - The request, after `requireAuth`.
 * @returns The context; the same promise on every call for this request.
 */
export function flagContextFor(request: Request): Promise<FlagContext> {
  if (!request.user) return Promise.reject(new Error('flagContextFor runs after requireAuth'))
  request.flagContext ??= flagContextForUser(
    request.user.id,
    // eslint-disable-next-line unicorn/no-null -- the reader's contract is null for no tenant
    request.principal?.tenantId ?? null,
    // eslint-disable-next-line unicorn/no-null -- the reader's contract is null for no session
    request.sessionId ?? null
  )
  return request.flagContext
}

/**
 * One flag's evaluation for this request, computed once per key.
 * @param request - The request, after `requireAuth`.
 * @param key - The flag.
 * @returns The evaluation; the same promise on every call for this request and key.
 */
export function evaluateForRequest(request: Request, key: FlagKey): Promise<FlagEvaluation> {
  request.flagEvaluations ??= new Map()
  const memo = request.flagEvaluations.get(key)
  if (memo) return memo
  const evaluation = (async () => evaluateKey(await flagContextFor(request), key))()
  request.flagEvaluations.set(key, evaluation)
  return evaluation
}
