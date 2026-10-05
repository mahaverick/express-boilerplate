/**
 * @file `requireFlag`, the route gate for a boolean feature flag. A closed
 * gate answers exactly the unknown-route 404, so a response never reveals
 * that a flag or its route exists. The value comes from the request's
 * memoised evaluation (`evaluateForRequest`), the same one the read
 * endpoints serve, and a gate read never records exposure.
 */
import type { NextFunction, Request, Response } from 'express'
import { flagEntry, type BooleanFlagKey } from '@/constants/flags.constants'
import { HttpError } from '@/errors/http-error'
import { evaluateForRequest } from '@/middlewares/flag-context.middleware'
import { logger } from '@/services/logger.service'

/**
 * Set on every handler `requireFlag` returns, holding its key and the value
 * that admits, so a test can walk the router and find each gate.
 */
export const FLAG_GATE_MARK = Symbol('flagGate')

/**
 * What a `requireFlag` handler carries under `FLAG_GATE_MARK`.
 */
export interface FlagGateMark {
  key: BooleanFlagKey
  shouldBeOn: boolean
}

/**
 * The handler `requireFlag` returns, with its mark.
 */
export type FlagGateHandler = ((
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<void>) & { [FLAG_GATE_MARK]: FlagGateMark }

/**
 * Whether an evaluation failed with a 404, which only an unreadable user causes.
 * @param error - What the evaluation rejected with.
 * @returns True for an `HttpError` with status 404.
 */
function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 404
}

/**
 * Admit the request only when the flag is on for the caller (off, with
 * `shouldBeOn` false). Mount it after `requireAuth`, after `resolveTenant()`
 * for a tenant-scoped flag, and before any validator. A tenant-scoped flag on a
 * request with no `request.principal` is a wiring mistake: it answers the
 * same 404 and logs `flag_gate_no_tenant` at `error`. An evaluation that
 * fails with a 404 (the user was deleted since `requireAuth`) answers that
 * same 404; any other failure goes to `next` unchanged.
 * @param key - The boolean flag that opens the route.
 * @param shouldBeOn - The value that admits; `false` serves a route only while the flag is off.
 * @returns An Express middleware, marked with `FLAG_GATE_MARK`.
 */
export function requireFlag(key: BooleanFlagKey, shouldBeOn = true): FlagGateHandler {
  const isTenantScoped = flagEntry(key).scope === 'tenant'
  const gate = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (isTenantScoped && request.principal === undefined) {
        logger.error('flag_gate_no_tenant', { flag: key })
        next(new HttpError('Not found', 404))
        return
      }
      const evaluation = await evaluateForRequest(request, key)
      if (evaluation.value !== shouldBeOn) {
        next(new HttpError('Not found', 404))
        return
      }
      next()
    } catch (error) {
      // A user the evaluation cannot find (deleted since `requireAuth`) is a closed gate, not a revealing 404 of its own.
      next(isNotFound(error) ? new HttpError('Not found', 404) : error)
    }
  }
  return Object.assign(gate, { [FLAG_GATE_MARK]: { key, shouldBeOn } })
}
