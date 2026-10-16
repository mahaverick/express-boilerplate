/**
 * @file The two audit-log reads. The tenant route is behind `resolveTenant` and
 * `requireRole('owner', 'admin')`; the platform route is behind
 * `requirePlatformRole('admin')`.
 */
import { BaseController } from '@/controllers/base.controller'
import { tenantPrincipal } from '@/controllers/helpers.controller'
import { hideStaffReason, toAuditEntry, toPlatformAuditEntry } from '@/presenters/audit.presenter'
import { listForTenant, listPlatformWide } from '@/services/audit.service'
import { successResponse } from '@/utilities/response.utilities'
import { platformAuditLogListSchema, tenantAuditLogListSchema } from '@/validators/audit.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * Handlers for the audit-log routes.
 */
class AuditController extends BaseController {
  /**
   * `GET /tenants/:slug/audit-log`: this tenant's entries, newest first. A member
   * does not see the reason staff gave for a staff action; staff (platform access) do.
   */
  listTenantAuditLog = this.handle(async (request, response) => {
    const principal = tenantPrincipal(request)
    const query = parseBody(tenantAuditLogListSchema, request.query)
    const page = await listForTenant(principal.tenantId, query)
    const shape =
      principal.access === 'member'
        ? (row: (typeof page.items)[number]) => hideStaffReason(toAuditEntry(row))
        : toAuditEntry
    successResponse(
      response,
      { ...page, items: page.items.map((row) => shape(row)) },
      'Audit log retrieved.'
    )
  })

  /**
   * `GET /platform/audit-log`: every tenant's entries, newest first.
   */
  listPlatformAuditLog = this.handle(async (request, response) => {
    const query = parseBody(platformAuditLogListSchema, request.query)
    const page = await listPlatformWide(query)
    successResponse(
      response,
      { ...page, items: page.items.map((row) => toPlatformAuditEntry(row)) },
      'Audit log retrieved.'
    )
  })
}

/**
 * The audit controller the tenant and platform routes mount.
 */
export const auditController = new AuditController()
