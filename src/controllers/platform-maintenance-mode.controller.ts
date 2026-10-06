/**
 * @file The handlers for `/api/v1/platform/maintenance-mode`: `GET` behind
 * `requirePlatformRole('viewer')`, `PUT` behind the owner role, step-up and
 * its own limiter (platform.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  changeMaintenanceMode,
  getPlatformMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode.service'
import { successResponse } from '@/utilities/response.utilities'
import { changeMaintenanceModeBody } from '@/validators/maintenance-mode.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * Handlers for the staff maintenance-mode routes.
 */
class PlatformMaintenanceModeController extends BaseController {
  /**
   * `GET /platform/maintenance-mode`: the stored mode, who set it, the queues and the environment name.
   */
  getMaintenanceMode = this.handle(async (_request, response) => {
    successResponse(response, await getPlatformMaintenanceMode(), 'Maintenance mode retrieved.')
  })

  /**
   * `PUT /platform/maintenance-mode`: change the mode; answers the view after the change.
   */
  changeMaintenanceMode = this.handle(async (request, response) => {
    const body = parseBody(changeMaintenanceModeBody, request.body)
    successResponse(
      response,
      await changeMaintenanceMode(actorFrom(request), body),
      'Maintenance mode updated.'
    )
  })
}

/**
 * The controller the staff maintenance-mode routes mount.
 */
export const platformMaintenanceModeController = new PlatformMaintenanceModeController()
