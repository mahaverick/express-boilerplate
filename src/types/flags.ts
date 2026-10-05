/**
 * @file The feature-flag types the registry, the evaluator, the snapshot
 * pipeline and the HTTP layer share. It imports nothing, so every flags
 * module can depend on it without a cycle.
 */

/**
 * What a flag is rolled out by: each user, or each tenant as a whole.
 */
export type FlagScope = 'user' | 'tenant'

/**
 * A browser app that can receive a flag's value.
 */
export type FlagApp = 'react' | 'apex'

/**
 * Who reported an experiment exposure: express itself (a service read), or
 * a browser app's hook through the exposure endpoint.
 */
export type ExposureOrigin = 'server' | 'react' | 'apex'

/**
 * Everything one evaluation reads: the user, the tenant group, and the
 * traits (`FLAG_TRAITS`). Traits never leave express except through the
 * staff evaluate view.
 */
export interface FlagContext {
  /**
   * The user's id: PostHog's distinct id.
   */
  distinctId: string
  /**
   * The tenant group key (the tenant id), absent when the evaluation has no tenant.
   */
  groups: { tenant?: string }
  /**
   * The person traits.
   */
  personProps: Record<string, string | number>
  /**
   * The tenant group's traits, absent when the evaluation has no tenant.
   */
  groupProps: { tenant?: Record<string, string | number> }
  /**
   * The tenant id, or null when the evaluation has no tenant.
   */
  tenantId: string | null
  /**
   * The refresh session id of the request, or null outside a request (a worker).
   */
  sessionId: string | null
}

/**
 * Why an evaluation gave its value. A `fallback:` reason means the registry
 * fallback was served because the flag could not be evaluated.
 */
export type FlagReason =
  | 'condition_match'
  | 'out_of_rollout'
  | 'no_condition_match'
  | 'holdout'
  | 'fallback:unconfigured'
  | 'fallback:snapshot_missing'
  | 'fallback:flag_missing'
  | 'fallback:inactive'
  | 'fallback:unsupported'
  | 'fallback:no_tenant'
  | 'fallback:inconclusive'

/**
 * One flag's value for one context, and why.
 */
export interface FlagEvaluation<V = boolean | string> {
  value: V
  reason: FlagReason
  /**
   * The index of the condition that matched, on `condition_match` only.
   */
  conditionIndex?: number
  /**
   * PostHog's holdout variant, on `holdout` only: the user is served the
   * fallback and their exposure is recorded as this value.
   */
  holdoutVariant?: `holdout-${number}`
}

/**
 * A registered flag's state in the current snapshot: `missing` when PostHog
 * has no such flag, `unsupported` when it uses a construct express does not
 * evaluate.
 */
export type FlagState = 'active' | 'inactive' | 'missing' | 'unsupported'

/**
 * Why a definitions fetch failed: PostHog refused the key (401 or 403),
 * answered another non-2xx status, timed out, could not be reached, sent a
 * body over the size cap, or sent a body that is not the definitions shape.
 */
export type FlagFetchErrorCode =
  'unauthorized' | 'http_error' | 'timeout' | 'network' | 'body_too_large' | 'invalid_body'

/**
 * The feature-flag section of the staff system status.
 */
export interface FlagsStatus {
  /**
   * Whether flags are configured (`isFlagsEnabled()`).
   */
  enabled: boolean
  /**
   * When this replica's snapshot was fetched, as ISO 8601; null without one.
   */
  snapshotAt: string | null
  /**
   * When PostHog last confirmed this replica's snapshot, as ISO 8601; null without one.
   */
  checkedAt: string | null
  /**
   * True when flags are enabled and the snapshot is missing or was last
   * confirmed more than `FLAG_SNAPSHOT_STALE_MS` ago.
   */
  stale: boolean
  /**
   * When any replica's fetch last succeeded (a 200 or a 304), as ISO 8601;
   * null when none did in the last day.
   */
  lastFetchOk: string | null
  /**
   * The code of the last failed fetch; null when none failed since the last success, or in the last day.
   */
  lastFetchError: FlagFetchErrorCode | null
  /**
   * The snapshot's `property_matching_version`; the numeric matching rule
   * was validated against 1 only.
   */
  propertyMatchingVersion: number | null
  /**
   * Registered flags by state in this replica's snapshot (all but
   * `registered` are 0 without one), PostHog flags the registry does not
   * declare, and evaluations that met an undeclared variant in the last
   * `FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES` minutes across replicas.
   */
  counts: {
    registered: number
    active: number
    inactive: number
    missing: number
    unsupported: number
    unregistered: number
    unknownVariant15m: number
  }
}

/**
 * One registered flag on `GET /platform/flags`: the registry entry, its live
 * state and a summary of its PostHog conditions.
 */
export interface FlagRow {
  key: string
  description: string
  kind: 'boolean' | 'multivariate'
  /**
   * The variants of a multivariate flag; null for a boolean one.
   */
  variants: readonly string[] | null
  scope: FlagScope
  client: boolean
  apps: readonly FlagApp[]
  experiment: boolean
  fallback: boolean | string
  /**
   * The flag's state in this replica's snapshot (`flagStateOf`), the same
   * classification the system status counts.
   */
  state: FlagState
  /**
   * Why the parser refused the definition; present only when `state` is `unsupported`.
   */
  unsupportedReason?: string
  /**
   * How many release conditions the definition has; 0 when missing.
   */
  conditions: number
  /**
   * The highest rollout percentage of any condition (a null rollout counts as
   * 100); null when the flag is missing or has no condition.
   */
  maxRollout: number | null
  /**
   * The flag's page in PostHog; null when it is missing or `POSTHOG_PROJECT_ID` is not set.
   */
  posthogUrl: string | null
}

/**
 * A flag PostHog has but the registry doesn't. Shown for information only;
 * nothing evaluates it.
 */
export interface UnregisteredRow {
  key: string
  active: boolean
  posthogUrl: string | null
}

/**
 * One targeting trait, for the inspector's Traits reference panel.
 */
export interface TraitRow {
  name: string
  where: 'person' | 'group'
  description: string
  examples: readonly string[]
}

/**
 * `GET /platform/flags`.
 */
export interface FlagsListResponse {
  items: FlagRow[]
  unregistered: UnregisteredRow[]
  traits: TraitRow[]
  snapshot: {
    /**
     * Whether flags are configured here; false renders the "not set up" state.
     */
    enabled: boolean
    fetchedAt: string | null
    stale: boolean
  }
}

/**
 * `GET /platform/flags/evaluate`: one user's (and optionally one tenant's)
 * traits and every registered flag's evaluation, with its reason.
 */
export interface FlagsEvaluateResponse {
  traits: Record<string, string | number>
  flags: {
    key: string
    value: boolean | string
    reason: FlagReason
    conditionIndex?: number
    holdoutVariant?: string
  }[]
  snapshot: { fetchedAt: string | null; stale: boolean }
}
