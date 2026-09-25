// src/constants/audit.constants.ts
//
// The fixed value sets of `audit_logs`, mirrored into its CHECK constraints.

/**
 * Who performed an audited action: a signed-in user, or the system (a script).
 */
export const AUDIT_ACTOR_KINDS = ['user', 'system'] as const

/**
 * One of `AUDIT_ACTOR_KINDS`.
 */
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

/**
 * How the actor reached the tenant: as a member, through platform access, or as the system.
 */
export const AUDIT_ACCESS_KINDS = ['member', 'platform', 'system'] as const

/**
 * One of `AUDIT_ACCESS_KINDS`.
 */
export type AuditAccess = (typeof AUDIT_ACCESS_KINDS)[number]

/**
 * The kinds of record an audit entry can point at.
 */
export const AUDIT_TARGET_TYPES = [
  'tenant',
  'membership',
  'invitation',
  'settings',
  'user',
] as const

/**
 * One of `AUDIT_TARGET_TYPES`.
 */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]
