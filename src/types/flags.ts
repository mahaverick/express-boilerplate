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
