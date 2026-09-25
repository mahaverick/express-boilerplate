// src/controllers/audit.controller.ts
//
// The two audit-log reads. The tenant route is behind resolveTenant and
// requireRole('owner', 'admin'); the platform route is behind
// requirePlatformRole('admin').
import { BaseController } from '@/controllers/base.controller'
import { tenantPrincipal } from '@/controllers/helpers.controller'
import { toAuditEntry, toPlatformAuditEntry } from '@/presenters/audit.presenter'
import { listForTenant, listPlatformWide } from '@/services/audit.service'
import { successResponse } from '@/utilities/response.utilities'
import {
  platformAuditLogQuerySchema,
  tenantAuditLogQuerySchema,
} from '@/validators/audit.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * Handlers for the audit-log routes.
 */
class AuditController extends BaseController {
  /**
   * `GET /tenants/:slug/audit-log`: this tenant's entries, newest first.
   */
  listTenantAuditLog = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const query = parseBody(tenantAuditLogQuerySchema, request.query)
    const page = await listForTenant(principal.tenantId, query)
    successResponse(
      response,
      { entries: page.rows.map((row) => toAuditEntry(row)), nextCursor: page.nextCursor },
      'Audit log retrieved.'
    )
  })

  /**
   * `GET /platform/audit-log`: every tenant's entries, newest first.
   */
  listPlatformAuditLog = this.handle(async (request, response) => {
    const query = parseBody(platformAuditLogQuerySchema, request.query)
    const page = await listPlatformWide(query)
    successResponse(
      response,
      { entries: page.rows.map((row) => toPlatformAuditEntry(row)), nextCursor: page.nextCursor },
      'Audit log retrieved.'
    )
  })
}

/**
 * The audit controller the tenant and platform routes mount.
 */
export const auditController = new AuditController()
