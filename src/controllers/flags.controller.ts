/**
 * @file Handlers for the flag read and exposure routes, three of each, and
 * the reference flag-gated route. The route fixes the app: the tenant and
 * tenantless routes serve react's client flags, `/platform/me/flags` serves
 * apex's. A read answers `{ flags, evaluatedAt }` with `Cache-Control:
 * no-store` and never a trait or a reason. An exposure report re-evaluates
 * every key on the server, never taking a value from the client, and
 * answers 204 whether or not anything was recorded.
 */
import type { Request, Response } from 'express'
import { BaseController } from '@/controllers/base.controller'
import { tenantPrincipal } from '@/controllers/helpers.controller'
import { evaluateForRequest, flagContextFor } from '@/middlewares/flag-context.middleware'
import { recordExposure } from '@/services/flags/flag-exposure.service'
import { flagsFor } from '@/services/flags/flags.service'
import type { FlagApp } from '@/types/flags'
import { successResponse } from '@/utilities/response.utilities'
import { parseExposureKeys } from '@/validators/flags.validators'

/**
 * What a flag read answers.
 */
interface ClientFlagsPayload {
  /**
   * Every client flag of the app, by key.
   */
  flags: Record<string, boolean | string>
  /**
   * When the server evaluated them, as an ISO timestamp.
   */
  evaluatedAt: string
}

/**
 * Answer a read with the app's client flags, uncached.
 * @param request - The request, after `requireAuth` (and `resolveTenant` on a tenant route).
 * @param response - The response.
 * @param app - The app the route serves.
 * @returns Resolves once sent.
 */
async function sendClientFlags(request: Request, response: Response, app: FlagApp): Promise<void> {
  const context = await flagContextFor(request)
  const payload: ClientFlagsPayload = {
    flags: await flagsFor(context, { app }),
    evaluatedAt: new Date().toISOString(),
  }
  response.set('Cache-Control', 'no-store')
  successResponse(response, payload, 'Flags retrieved.')
}

/**
 * Record exposure for every reported key, evaluated on the server, then answer 204.
 * @param request - The request, after the route's gates.
 * @param response - The response.
 * @param app - The app the route serves, recorded as the exposure's origin.
 * @returns Resolves once sent; a malformed body or key rejects with a 400 `HttpError`.
 */
async function recordReportedExposures(
  request: Request,
  response: Response,
  app: FlagApp
): Promise<void> {
  const keys = parseExposureKeys(request.body, app)
  const context = await flagContextFor(request)
  for (const key of keys) {
    const evaluation = await evaluateForRequest(request, key)
    await recordExposure(context, key, evaluation, app)
  }
  response.status(204).end()
}

/**
 * Handlers for the flag routes.
 */
class FlagsController extends BaseController {
  /**
   * `GET /tenants/:slug/flags`: react's client flags in the tenant.
   */
  getTenantFlags = this.handle(async (request, response) => {
    await sendClientFlags(request, response, 'react')
  })

  /**
   * `GET /flags`: react's client flags with no tenant.
   */
  getFlags = this.handle(async (request, response) => {
    await sendClientFlags(request, response, 'react')
  })

  /**
   * `GET /platform/me/flags`: apex's client flags for the staff member, with no tenant.
   */
  getPlatformFlags = this.handle(async (request, response) => {
    await sendClientFlags(request, response, 'apex')
  })

  /**
   * `POST /tenants/:slug/flags/exposures`: react's exposure report in the tenant.
   */
  recordTenantExposures = this.handle(async (request, response) => {
    await recordReportedExposures(request, response, 'react')
  })

  /**
   * `POST /flags/exposures`: react's exposure report with no tenant.
   */
  recordExposures = this.handle(async (request, response) => {
    await recordReportedExposures(request, response, 'react')
  })

  /**
   * `POST /platform/me/flags/exposures`: apex's exposure report.
   */
  recordPlatformExposures = this.handle(async (request, response) => {
    await recordReportedExposures(request, response, 'apex')
  })

  /**
   * `GET /tenants/:slug/beta`: the reference route behind `example_beta_page`.
   */
  getExampleBeta = this.handle((request, response) => {
    const { tenantSlug } = tenantPrincipal(request)
    successResponse(
      response,
      { slug: tenantSlug, enabledAt: new Date().toISOString() },
      'Beta features are on.'
    )
  })
}

/**
 * The controller the flag routes mount.
 */
export const flagsController = new FlagsController()
