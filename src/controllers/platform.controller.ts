/**
 * @file Handlers for `/api/v1/platform`. Every route runs behind `requireAuth`
 * and `requirePlatformRole` (platform.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { getPlatformStats } from '@/services/platform-stats.service'
import { searchAll } from '@/services/platform-tenant.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  platformStatsQuerySchema,
  platformTenantSearchSchema,
} from '@/validators/platform.validators'

/**
 * Handlers for `/api/v1/platform`.
 */
class PlatformController extends BaseController {
  /**
   * `GET /platform/tenants`: search every customer tenant by name or slug.
   */
  searchTenants = this.handle(async (request, response) => {
    const query = parseBody(platformTenantSearchSchema, request.query)
    const page = await searchAll(query)
    successResponse(response, page, 'Tenants retrieved.')
  })

  /**
   * `GET /platform/stats`: totals and daily series for the staff Overview.
   */
  getStats = this.handle(async (request, response) => {
    const query = parseBody(platformStatsQuerySchema, request.query)
    const stats = await getPlatformStats(query.range)
    successResponse(response, stats, 'Platform stats retrieved.')
  })
}

/**
 * The platform controller the platform routes mount.
 */
export const platformController = new PlatformController()
