/**
 * @file Handlers for `/api/v1/platform`. Every route runs behind `requireAuth`
 * and `requirePlatformRole` (platform.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import { purgeTenant } from '@/services/platform-purge.service'
import { getPlatformStats } from '@/services/platform-stats.service'
import {
  archiveTenant,
  createTenant,
  getTenantDetail,
  reactivateTenant,
  reissueOwnerInvitation,
  searchAll,
  suspendTenant,
} from '@/services/platform-tenant.service'
import { messageResponse, successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  ownerInvitationBodySchema,
  parseIdParameter,
  platformNewTenantSchema,
  platformStatsQuerySchema,
  platformTenantSearchSchema,
  reasonBodySchema,
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
   * `GET /platform/tenants/:id`: one customer tenant in any lifecycle state.
   */
  getTenant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const tenant = await getTenantDetail(tenantId)
    successResponse(response, tenant, 'Tenant retrieved.')
  })

  /**
   * `POST /platform/tenants`: create a customer tenant and invite its owner.
   */
  createTenant = this.handle(async (request, response) => {
    const input = parseBody(platformNewTenantSchema, request.body)
    const result = await createTenant(actorFrom(request), input)
    successResponse(response, result, 'Tenant created.', 201)
  })

  /**
   * `POST /platform/tenants/:id/owner-invitation`: invite a new owner to an ownerless tenant.
   */
  reissueOwnerInvitation = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const { email, reason } = parseBody(ownerInvitationBodySchema, request.body)
    const result = await reissueOwnerInvitation(actorFrom(request), tenantId, email, reason)
    successResponse(response, result, 'Owner invitation sent.')
  })

  /**
   * `POST /platform/tenants/:id/suspend`.
   */
  suspendTenant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await suspendTenant(actorFrom(request), tenantId, reason),
      'Tenant suspended.'
    )
  })

  /**
   * `POST /platform/tenants/:id/reactivate`.
   */
  reactivateTenant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await reactivateTenant(actorFrom(request), tenantId, reason),
      'Tenant reactivated.'
    )
  })

  /**
   * `POST /platform/tenants/:id/archive`.
   */
  archiveTenant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await archiveTenant(actorFrom(request), tenantId, reason),
      'Tenant archived.'
    )
  })

  /**
   * `POST /platform/tenants/:id/purge`: permanently delete an archived tenant.
   */
  purgeTenant = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'Tenant not found')
    const { reason } = parseBody(reasonBodySchema, request.body)
    await purgeTenant(actorFrom(request), tenantId, reason)
    messageResponse(response, 'Tenant permanently deleted.')
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
