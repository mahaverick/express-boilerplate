/**
 * @file The entitlement registry: every limit and feature a plan can grant,
 * with the values Free and Paid start from. Code reads limits and features by
 * these keys only, so a new one is a new entry here.
 */

/**
 * What an entitlement holds: a feature switch, a numeric limit, or `null`
 * for a limit with no cap.
 */
type EntitlementValue = boolean | number | null

/**
 * Whether an entitlement is an on/off feature or a counted limit.
 */
type EntitlementKind = 'feature' | 'limit'

/**
 * One registry entry.
 */
export interface EntitlementDefinition {
  /**
   * Whether the value is a boolean switch or a count.
   */
  kind: EntitlementKind
  /**
   * The name people see.
   */
  label: string
  /**
   * One sentence on what the entitlement covers.
   */
  description: string
  /**
   * The value each seeded plan starts with.
   */
  defaults: { free: EntitlementValue; paid: EntitlementValue }
  /**
   * For a limit, the share of the cap (0 to 1) at which a warning starts.
   */
  softAt?: number
}

/**
 * Every entitlement the product knows.
 */
export const ENTITLEMENTS = {
  members: {
    kind: 'limit',
    label: 'Members',
    description: 'People in the workspace, counting pending invitations.',
    defaults: { free: 3, paid: null },
    softAt: 0.8,
  },
  advanced_example: {
    kind: 'feature',
    label: 'Workspace insights',
    description: 'Who joined and how many invitations went out in the last 30 days.',
    defaults: { free: false, paid: true },
  },
} as const satisfies Record<string, EntitlementDefinition>

/**
 * A key of the registry.
 */
export type EntitlementKey = keyof typeof ENTITLEMENTS

/**
 * A registry entry with its key, as the catalog lists it.
 */
export interface EntitlementCatalogEntry extends EntitlementDefinition {
  /**
   * The registry key.
   */
  key: EntitlementKey
}

/**
 * The registry as a list, in declaration order.
 * @returns One entry per entitlement, each carrying its key.
 */
export function entitlementCatalog(): EntitlementCatalogEntry[] {
  return (Object.keys(ENTITLEMENTS) as EntitlementKey[]).map((key) => ({
    key,
    ...(ENTITLEMENTS[key] as EntitlementDefinition),
  }))
}
