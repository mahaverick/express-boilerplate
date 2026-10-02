/**
 * @file Every PII rule of the analytics pipeline, in one place: pure
 * functions from an audit row (and, later, product and email events) to the
 * outbox rows sent to PostHog. Every property key is snake_case; every
 * server event carries `source`, `access`, `app: 'api'`, the tenant group
 * when there is one, and the trace and browser session that caused it.
 * `scrubPiiProperties` drops banned keys and address-shaped values from the
 * event's own properties as a backstop; `$set`, `$set_once`, `$groups` and
 * `$group_set` are built here from fixed fields and are not inspected.
 */
import {
  AUDIT_EVENT_RENAMES,
  PII_PROPERTY_KEYS,
  SYSTEM_DISTINCT_ID,
} from '@/constants/analytics.constants'
import type { AuditAccess, AuditAction } from '@/constants/audit.constants'
import { onboardingStepByKey } from '@/constants/onboarding.constants'
import type { NewAnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import type { AuditLog } from '@/database/models/audit-log.model'
import { logger } from '@/services/logger.service'
import type {
  AnalyticsContext,
  AuditEventExtras,
  StaffStatusSnapshot,
  TenantGroupSnapshot,
} from '@/types/analytics'

/**
 * Where a server event came from.
 */
export type AnalyticsSource = 'audit' | 'product' | 'email'

/**
 * The audit metadata keys never copied onto an event: `reason` becomes
 * `has_reason`, and `name` (a tenant's name) reaches PostHog only through
 * the tenant group's `$group_set`.
 */
const AUDIT_METADATA_OMITTED_KEYS: ReadonlySet<string> = new Set(['reason', 'name'])

const PII_KEYS: ReadonlySet<string> = new Set(PII_PROPERTY_KEYS)

/**
 * The PostHog group type every tenant event joins.
 */
const TENANT_GROUP_TYPE = 'tenant'

/**
 * Convert one camelCase key to snake_case.
 * @param key - The key, e.g. `stepKey`.
 * @returns The key in snake_case, e.g. `step_key`.
 */
function toSnakeCase(key: string): string {
  return key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/**
 * Shallowly convert a record's keys to snake_case; values are kept as they are.
 * @param record - The record, e.g. audit metadata.
 * @returns A new record with snake_case keys.
 */
export function toSnakeCaseKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [toSnakeCase(key), value]))
}

/**
 * Whether a string looks like an email address: an `@` with something
 * before it and a dot somewhere after the character that follows it.
 * @param value - The string.
 * @returns True for an address-shaped string.
 */
function isEmailShaped(value: string): boolean {
  const at = value.indexOf('@')
  return at > 0 && value.slice(at + 2).includes('.')
}

/**
 * Whether a property value is, or (as an array) contains, an address-shaped string.
 * @param value - The value.
 * @returns True when the value must not be sent.
 */
function hasEmailValue(value: unknown): boolean {
  if (typeof value === 'string') return isEmailShaped(value)
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'string' && isEmailShaped(item))
  }
  return false
}

/**
 * Drop every property whose key is a banned PII key, or whose value is (or
 * is an array containing) an address-shaped string. Shallow: nested objects
 * are kept as they are.
 * @param properties - An event's own properties.
 * @returns The kept properties, and the dropped keys (never their values).
 */
export function scrubPiiProperties(properties: Record<string, unknown>): {
  properties: Record<string, unknown>
  droppedKeys: string[]
} {
  const kept: Record<string, unknown> = {}
  const droppedKeys: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (PII_KEYS.has(key) || hasEmailValue(value)) {
      droppedKeys.push(key)
      continue
    }
    kept[key] = value
  }
  return { properties: kept, droppedKeys }
}

/**
 * Scrub an event's own properties, logging the keys of any it drops.
 * @param event - The event name, for the log.
 * @param properties - The event's own properties.
 * @returns The kept properties.
 */
function scrubbed(event: string, properties: Record<string, unknown>): Record<string, unknown> {
  const result = scrubPiiProperties(properties)
  if (result.droppedKeys.length > 0) {
    logger.warn('Analytics properties dropped by the PII guard', {
      event,
      droppedKeys: result.droppedKeys,
    })
  }
  return result.properties
}

/**
 * What the common properties of one server event are built from.
 */
interface CommonInput {
  source: AnalyticsSource
  access: AuditAccess
  distinctId: string
  tenantId?: string | undefined
  context: AnalyticsContext
}

/**
 * The properties every server event carries.
 * @param input - The event's source, access, distinct id, tenant and context.
 * @returns `source`, `access`, `app`, `$groups` (with a tenant), `trace_id`
 * and `span_id` (with a span), `$session_id` (with a browser session), and
 * `$process_person_profile: false` for the system distinct id.
 */
export function commonProperties(input: CommonInput): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    source: input.source,
    access: input.access,
    app: 'api',
  }
  if (input.tenantId !== undefined) properties.$groups = { [TENANT_GROUP_TYPE]: input.tenantId }
  if (input.context.traceId !== undefined) properties.trace_id = input.context.traceId
  if (input.context.spanId !== undefined) properties.span_id = input.context.spanId
  if (input.context.posthogSessionId !== undefined) {
    properties.$session_id = input.context.posthogSessionId
  }
  if (input.distinctId === SYSTEM_DISTINCT_ID) properties.$process_person_profile = false
  return properties
}

/**
 * The event name an audit action is sent under: the action with `.` turned
 * into `_`, unless `AUDIT_EVENT_RENAMES` names another.
 * @param action - The audit action.
 * @returns The PostHog event name.
 */
export function auditEventName(action: AuditAction): string {
  const renames: Partial<Record<AuditAction, string>> = AUDIT_EVENT_RENAMES
  return renames[action] ?? action.replaceAll('.', '_')
}

/**
 * The event-specific properties of an audit row: its target, its metadata
 * in snake_case without `reason` (as `has_reason`) and `name`, and, for a
 * staff onboarding completion, the `how` and `required` every
 * `onboarding_step_completed` carries.
 * @param entry - The inserted audit row.
 * @returns The properties, not yet scrubbed.
 */
function auditProperties(entry: AuditLog): Record<string, unknown> {
  const metadata = entry.metadata
  const kept = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AUDIT_METADATA_OMITTED_KEYS.has(key))
  )
  const properties: Record<string, unknown> = {
    target_type: entry.targetType,
    target_id: entry.targetId,
    ...toSnakeCaseKeys(kept),
  }
  if (Object.hasOwn(metadata, 'reason')) {
    properties.has_reason = typeof metadata.reason === 'string' && metadata.reason.length > 0
  }
  if (entry.action === 'onboarding.step_completed') {
    const stepKey = typeof metadata.stepKey === 'string' ? metadata.stepKey : ''
    properties.how = 'manual'
    properties.required = onboardingStepByKey(stepKey)?.required ?? false
  }
  return properties
}

/**
 * The `$groupidentify` row that sets a tenant group's properties, as
 * posthog-node's `groupIdentify` sends it: `distinct_id` is
 * `$tenant_<id>`, and no person is created for it.
 * @param tenant - The tenant as it now is.
 * @param context - The trace and session to link it to.
 * @param source - What prompted it.
 * @param access - How the actor reached the tenant.
 * @param occurredAt - When it happened.
 * @returns The row.
 */
export function buildTenantGroupIdentify(
  tenant: TenantGroupSnapshot,
  context: AnalyticsContext,
  source: AnalyticsSource,
  access: AuditAccess,
  occurredAt: Date
): NewAnalyticsOutboxRow {
  return {
    event: '$groupidentify',
    distinctId: `$${TENANT_GROUP_TYPE}_${tenant.id}`,
    occurredAt,
    properties: {
      ...commonProperties({ source, access, distinctId: SYSTEM_DISTINCT_ID, context }),
      $group_type: TENANT_GROUP_TYPE,
      $group_key: tenant.id,
      $group_set: {
        name: tenant.name,
        status: tenant.status,
        created_at: tenant.createdAt.toISOString(),
      },
    },
  }
}

/**
 * The `$set` row that updates another user's server-owned staff status.
 * It is a separate row because a `$set` on the actor's own event would
 * update the actor.
 * @param staff - The affected user and their platform role after the change.
 * @param context - The trace and session to link it to.
 * @param access - How the actor reached the tenant.
 * @param occurredAt - When it happened.
 * @returns The row.
 */
function buildStaffStatusSet(
  staff: StaffStatusSnapshot,
  context: AnalyticsContext,
  access: AuditAccess,
  occurredAt: Date
): NewAnalyticsOutboxRow {
  return {
    event: '$set',
    distinctId: staff.userId,
    occurredAt,
    properties: {
      ...commonProperties({ source: 'audit', access, distinctId: staff.userId, context }),
      $set: { is_staff: staff.platformRole !== null, platform_role: staff.platformRole },
    },
  }
}

/**
 * The outbox rows for one inserted audit row: the event itself, then a
 * `$groupidentify` row when `extras.tenant` is given, then a staff-status
 * `$set` row when `extras.staffStatus` is given.
 * @param entry - The inserted audit row.
 * @param context - The trace and session it happened in.
 * @param extras - The tenant and staff snapshots the action calls for.
 * @returns The rows, in that order.
 */
export function buildAuditEvents(
  entry: AuditLog,
  context: AnalyticsContext,
  extras: AuditEventExtras = {}
): NewAnalyticsOutboxRow[] {
  const event = auditEventName(entry.action)
  const distinctId =
    entry.actorKind === 'user' && entry.actorUserId !== null
      ? entry.actorUserId
      : SYSTEM_DISTINCT_ID
  const rows: NewAnalyticsOutboxRow[] = [
    {
      event,
      distinctId,
      occurredAt: entry.occurredAt,
      properties: {
        ...scrubbed(event, auditProperties(entry)),
        ...commonProperties({
          source: 'audit',
          access: entry.access,
          distinctId,
          tenantId: entry.tenantId,
          context,
        }),
      },
    },
  ]
  if (extras.tenant) {
    rows.push(
      buildTenantGroupIdentify(extras.tenant, context, 'audit', entry.access, entry.occurredAt)
    )
  }
  if (extras.staffStatus) {
    rows.push(buildStaffStatusSet(extras.staffStatus, context, entry.access, entry.occurredAt))
  }
  return rows
}
