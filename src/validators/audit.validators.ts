// src/validators/audit.validators.ts
//
// Query shapes for the tenant and platform audit-log reads. The cursor is
// decoded here; a malformed one is a 400.
import { z } from 'zod'
import { AUDIT_ACCESS_KINDS, AUDIT_ACTION_NAMES } from '@/constants/audit.constants'
import { cursorField } from '@/validators/cursor.validators'

const DEFAULT_AUDIT_PAGE_SIZE = 50
const MAX_AUDIT_PAGE_SIZE = 100

/**
 * The audit cursor's decoded shape: the last entry's time and id.
 */
export const auditCursorSchema = z.object({ occurredAt: z.iso.datetime(), id: z.uuid() }).strict()

const pageFields = {
  cursor: cursorField(auditCursorSchema).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIT_PAGE_SIZE, `limit must be at most ${MAX_AUDIT_PAGE_SIZE}.`)
    .default(DEFAULT_AUDIT_PAGE_SIZE),
  action: z.enum(AUDIT_ACTION_NAMES).optional(),
  actorUserId: z.uuid('actorUserId must be a valid UUID.').optional(),
  access: z.enum(AUDIT_ACCESS_KINDS).optional(),
}

/**
 * `GET /api/v1/tenants/:slug/audit-log` query string.
 */
export const tenantAuditLogQuerySchema = z.object(pageFields)

/**
 * The validated tenant audit-log query, with the cursor already decoded.
 */
export type TenantAuditLogQuery = z.infer<typeof tenantAuditLogQuerySchema>

/**
 * `GET /api/v1/platform/audit-log` query string.
 */
export const platformAuditLogQuerySchema = z.object({
  ...pageFields,
  tenantId: z.uuid('tenantId must be a valid UUID.').optional(),
})

/**
 * The validated platform audit-log query, with the cursor already decoded.
 */
export type PlatformAuditLogQuery = z.infer<typeof platformAuditLogQuerySchema>
