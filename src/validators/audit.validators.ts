/**
 * @file Query shapes for the tenant and platform audit-log reads, on the shared list params.
 */
import { z } from 'zod'
import { AUDIT_ACCESS_KINDS, AUDIT_ACTION_NAMES } from '@/constants/audit.constants'
import { listFilter, listParamsSchema } from '@/validators/list.validators'

/**
 * The filters both audit-log reads take: actions and access paths as comma lists, and one actor.
 */
const auditFilters = {
  action: listFilter('action', AUDIT_ACTION_NAMES).optional(),
  actor: z.uuid('actor must be a valid UUID.').optional(),
  access: listFilter('access', AUDIT_ACCESS_KINDS).optional(),
}

/**
 * `GET /api/v1/tenants/:slug/audit-log` query: the shared list params,
 * `search` matching the action, the actor's email and the target's label.
 */
export const tenantAuditLogListSchema = listParamsSchema({
  sorts: ['-occurred', 'occurred'],
  defaultSort: '-occurred',
  filters: auditFilters,
})

/**
 * A parsed tenant audit-log query.
 */
export type TenantAuditLogListQuery = z.output<typeof tenantAuditLogListSchema>

/**
 * `GET /api/v1/platform/audit-log` query: the tenant filters plus one tenant and one target.
 */
export const platformAuditLogListSchema = listParamsSchema({
  sorts: ['-occurred', 'occurred'],
  defaultSort: '-occurred',
  filters: {
    ...auditFilters,
    tenant: z.uuid('tenant must be a valid UUID.').optional(),
    target: z.uuid('target must be a valid UUID.').optional(),
  },
})

/**
 * A parsed platform audit-log query.
 */
export type PlatformAuditLogListQuery = z.output<typeof platformAuditLogListSchema>
