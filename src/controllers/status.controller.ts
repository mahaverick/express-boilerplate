/**
 * @file The handler for `GET /api/v1/status/maintenance`, the public
 * maintenance status, behind its own per-IP limiter (status.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { getPublicMaintenanceStatus } from '@/services/maintenance-mode/maintenance-mode.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * How long a browser or proxy may reuse the public status.
 */
const STATUS_CACHE_CONTROL = 'public, max-age=5'

/**
 * Handlers for the public status routes.
 */
class StatusController extends BaseController {
  /**
   * `GET /status/maintenance`: `{ mode, message, since }` from this replica's memory.
   */
  getMaintenance = this.handle((_request, response) => {
    response.setHeader('Cache-Control', STATUS_CACHE_CONTROL)
    successResponse(response, getPublicMaintenanceStatus(), 'Maintenance status retrieved.')
  })
}

/**
 * The controller the status routes mount.
 */
export const statusController = new StatusController()
