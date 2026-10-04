/**
 * @file The handler for `GET /api/v1/platform/system/status`, behind
 * `requireAuth`, `requirePlatformRole('admin')` and the shared
 * `platform-search` limiter (platform.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { getSystemStatus } from '@/services/platform-system.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * The handler for the system status route.
 */
class PlatformSystemController extends BaseController {
  /**
   * `GET /platform/system/status`: the release and error tracking's health.
   */
  getStatus = this.handle(async (_request, response) => {
    successResponse(response, await getSystemStatus(), 'System status retrieved.')
  })
}

/**
 * The controller the system status route mounts.
 */
export const platformSystemController = new PlatformSystemController()
