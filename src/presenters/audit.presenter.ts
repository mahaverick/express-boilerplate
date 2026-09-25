// src/presenters/audit.presenter.ts
//
// Audit rows to their wire shape. The stored ip, user agent and request id
// stay server-side.
import type { AuditLog } from '@/database/models/audit-log.model'

/**
 * An audit row with its actor (null when no user row joined) and tenant.
 */
export interface JoinedAuditRow {
  entry: AuditLog
  actor: { id: string; email: string; firstName: string | null; lastName: string | null } | null
  tenant: { id: string; name: string; slug: string }
}

/**
 * Who acted, as a client sees it.
 */
export interface AuditActorResponse {
  id: string
  name: string
  email: string
}

/**
 * One entry of `GET /tenants/:slug/audit-log`.
 */
export interface AuditEntryResponse {
  id: string
  occurredAt: Date
  action: AuditLog['action']
  access: AuditLog['access']
  actor: AuditActorResponse | null
  target: { type: NonNullable<AuditLog['targetType']>; id: string } | null
  metadata: AuditLog['metadata']
}

/**
 * One entry of `GET /platform/audit-log`: an entry plus its tenant.
 */
export interface PlatformAuditEntryResponse extends AuditEntryResponse {
  tenant: { id: string; name: string; slug: string }
}

/**
 * A display name: first and last name, or the email when neither is set.
 * @param actor - The joined user.
 * @returns A non-empty name.
 */
function displayName(actor: NonNullable<JoinedAuditRow['actor']>): string {
  const name = [actor.firstName, actor.lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
  return name === '' ? actor.email : name
}

/**
 * Map a joined audit row to its tenant-scoped wire shape.
 * @param row - The entry with its actor and tenant.
 * @returns The contract's `AuditEntry`.
 */
export function toAuditEntry(row: JoinedAuditRow): AuditEntryResponse {
  const { entry, actor } = row
  return {
    id: entry.id,
    occurredAt: entry.occurredAt,
    action: entry.action,
    access: entry.access,
    actor:
      actor !== null && entry.actorKind === 'user'
        ? { id: actor.id, name: displayName(actor), email: actor.email }
        : // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for a system actor
          null,
    target:
      entry.targetType !== null && entry.targetId !== null
        ? { type: entry.targetType, id: entry.targetId }
        : // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for no target
          null,
    metadata: entry.metadata,
  }
}

/**
 * Map a joined audit row to its platform-wide wire shape.
 * @param row - The entry with its actor and tenant.
 * @returns The contract's `AuditEntry` plus `tenant`.
 */
export function toPlatformAuditEntry(row: JoinedAuditRow): PlatformAuditEntryResponse {
  return { ...toAuditEntry(row), tenant: row.tenant }
}
