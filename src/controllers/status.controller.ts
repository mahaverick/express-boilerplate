/**
 * @file The handlers for the public status routes: `GET /api/v1/status/maintenance`
 * and `GET /api/v1/status/client-settings`, each behind its own per-IP
 * limiter (status.routes.ts).
 */
import { getEnv } from '@/configs/env.config'
import { BaseController } from '@/controllers/base.controller'
import { clientSettingsFrom } from '@/services/client-settings.service'
import { getPublicMaintenanceStatus } from '@/services/maintenance-mode/maintenance-mode.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * How long a browser or proxy may reuse the public status.
 */
const STATUS_CACHE_CONTROL = 'public, max-age=5'

/**
 * How long a browser or proxy may reuse the client settings: they change
 * only with a deployment, and the apps hold them for as long.
 */
const CLIENT_SETTINGS_CACHE_CONTROL = 'public, max-age=300'

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

  /**
   * `GET /status/client-settings`: the link lifetimes in seconds and the
   * support address, from the environment, the same for every caller.
   */
  getClientSettings = this.handle((_request, response) => {
    response.setHeader('Cache-Control', CLIENT_SETTINGS_CACHE_CONTROL)
    successResponse(response, clientSettingsFrom(getEnv()), 'Client settings retrieved.')
  })
}

/**
 * The controller the status routes mount.
 */
export const statusController = new StatusController()
