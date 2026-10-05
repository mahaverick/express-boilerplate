/**
 * @file Evaluates one registered flag for one context from the snapshot,
 * exactly as PostHog's flags service does (8,200 of 8,200 cases matched in
 * the planning probe; the golden fixtures pin them). It reads no clock
 * beyond what core's relative-date matching uses, and its only I/O is a warn
 * log when core throws something other than an inconclusive match. It never
 * throws: every case it cannot evaluate answers the registry fallback with
 * a `fallback:` reason.
 */
import {
  getFeatureFlagHash,
  getFeatureFlagVariant,
  getHoldoutVariant,
  InconclusiveMatchError,
  matchFeatureFlagProperty,
  type FeatureFlagProperty,
} from '@posthog/core'
import type { FlagEntry } from '@/constants/flags.constants'
import { logger } from '@/services/logger.service'
import type { FlagContext, FlagEvaluation, FlagReason, FlagState } from '@/types/flags'
import type {
  FlagDefinitionJson,
  FlagPropertyJson,
  ParsedDefinition,
  ParsedSnapshot,
} from '@/validators/flag-definition.validators'

/**
 * The operators core compares numerically (it parses both sides), so a
 * number stays a number for them.
 */
const NUMERIC_OPERATORS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte'])

/**
 * The operators PostHog answers true for when the property is absent.
 */
const TRUE_WHEN_ABSENT: ReadonlySet<string> = new Set(['is_not', 'is_not_set'])

const HOLDOUT_VARIANT = /^holdout-\d+$/

/**
 * How one evaluation runs.
 */
export interface EvaluateOptions {
  /**
   * Whether flags are configured (`isFlagsEnabled()`); false serves every fallback.
   */
  isConfigured: boolean
  /**
   * Called with the flag key when PostHog chose a variant the registry does not declare.
   */
  onUnknownVariant?: (key: string) => void
}

/**
 * The fallback answer of an entry.
 * @param entry - The registry entry.
 * @param reason - Why the fallback is served.
 * @returns The evaluation.
 */
function fallback(entry: FlagEntry, reason: FlagReason): FlagEvaluation {
  return { value: entry.fallback, reason }
}

/**
 * A snapshot's definition of one key, read as an own property only, so a
 * key such as `constructor` never reads the object prototype.
 * @param snapshot - The snapshot.
 * @param key - The flag key.
 * @returns The definition, or undefined.
 */
export function definitionOf(snapshot: ParsedSnapshot, key: string): ParsedDefinition | undefined {
  return Object.hasOwn(snapshot.flags, key) ? snapshot.flags[key] : undefined
}

/**
 * A registered flag's state in the snapshot. Unsupported wins over inactive.
 * @param definition - The flag's definition, or undefined when PostHog has none.
 * @returns The state.
 */
export function flagStateOf(definition: ParsedDefinition | undefined): FlagState {
  if (definition === undefined) return 'missing'
  if (definition.unsupported !== null) return 'unsupported'
  return definition.active ? 'active' : 'inactive'
}

/**
 * Whether an error is core's `InconclusiveMatchError`, by class or by name:
 * tsx can load core twice (CommonJS and ESM), and `instanceof` then fails.
 * @param error - What was thrown.
 * @returns True for an inconclusive match.
 */
export function isInconclusiveMatchError(error: unknown): boolean {
  return (
    error instanceof InconclusiveMatchError ||
    (error instanceof Error && error.name === 'InconclusiveMatchError')
  )
}

/**
 * The values a person property is matched against: the person traits and
 * the implicit `distinct_id` (a trait of that name would win, as in PostHog).
 * @param context - The context.
 * @returns The values.
 */
function personSource(context: FlagContext): Record<string, unknown> {
  return { distinct_id: context.distinctId, ...context.personProps }
}

/**
 * The values a group property is matched against: the tenant traits and the
 * implicit `$group_key`, which always equals the real group key.
 * @param context - The context.
 * @returns The values; empty without a tenant.
 */
function groupSource(context: FlagContext): Record<string, unknown> {
  const tenant = context.groups.tenant
  return tenant === undefined ? {} : { ...context.groupProps.tenant, $group_key: tenant }
}

/**
 * Match one condition property with PostHog's semantics, through core's
 * `matchFeatureFlagProperty`. Unlike core, an absent property is false
 * (true for `is_not` and `is_not_set`) rather than inconclusive, and a
 * number is matched as its decimal string except by `gt`/`gte`/`lt`/`lte`,
 * since core refuses `exact` against an integer. That numeric rule was
 * checked under `property_matching_version` 1 only.
 * @param property - The property.
 * @param context - The context.
 * @param propertyMatchingVersion - The snapshot's `property_matching_version`, or null.
 * @returns Whether it matches.
 * @throws {InconclusiveMatchError} For a value core cannot read (a malformed date, semver or regex).
 */
export function isFlagPropertyMatch(
  property: FlagPropertyJson,
  context: FlagContext,
  propertyMatchingVersion: number | null
): boolean {
  const operator = property.operator ?? 'exact'
  const source = property.type === 'group' ? groupSource(context) : personSource(context)
  if (!Object.hasOwn(source, property.key)) return TRUE_WHEN_ABSENT.has(operator)
  const actual = source[property.key]
  const value =
    typeof actual === 'number' && Number.isFinite(actual) && !NUMERIC_OPERATORS.has(operator)
      ? String(actual)
      : actual
  const coreProperty: FeatureFlagProperty = {
    key: property.key,
    value: property.value as FeatureFlagProperty['value'],
    operator,
  }
  return matchFeatureFlagProperty(
    coreProperty,
    { [property.key]: value },
    propertyMatchingVersion === null ? {} : { propertyMatchingVersion }
  )
}

/**
 * The answer for a condition that matched and is in rollout.
 * @param entry - The registry entry.
 * @param raw - The definition.
 * @param conditionIndex - The matched condition's index.
 * @param variant - The variant chosen, for a multivariate definition.
 * @param options - The evaluation options.
 * @returns The evaluation: true, a declared variant, or the fallback for an undeclared one.
 */
function matchedResult(
  entry: FlagEntry,
  raw: FlagDefinitionJson,
  conditionIndex: number,
  variant: string | undefined,
  options: EvaluateOptions
): FlagEvaluation {
  if (entry.kind === 'boolean') return { value: true, reason: 'condition_match', conditionIndex }
  const variants: readonly string[] = entry.variants
  if (variant !== undefined && variants.includes(variant)) {
    return { value: variant, reason: 'condition_match', conditionIndex }
  }
  options.onUnknownVariant?.(raw.key)
  return fallback(entry, 'fallback:unsupported')
}

/**
 * Evaluate an active, supported definition.
 * @param entry - The registry entry.
 * @param raw - The definition.
 * @param snapshot - The snapshot, for the tenant index and matching version.
 * @param context - The context.
 * @param options - The evaluation options.
 * @returns The evaluation.
 */
async function evaluateDefinition(
  entry: FlagEntry,
  raw: FlagDefinitionJson,
  snapshot: ParsedSnapshot,
  context: FlagContext,
  options: EvaluateOptions
): Promise<FlagEvaluation> {
  const bucketing = bucketingValueOf(raw, snapshot, context)
  if (typeof bucketing !== 'string') return fallback(entry, bucketing.reason)
  return evaluateBucketed(entry, raw, snapshot, context, options, bucketing)
}

/**
 * The value a definition buckets on: the distinct id for a person-aggregated
 * flag, the tenant group key for one aggregated on the snapshot's tenant index.
 * @param raw - The definition.
 * @param snapshot - The snapshot, for the tenant index.
 * @param context - The context.
 * @returns The value, or the fallback reason when there is none to bucket on.
 */
function bucketingValueOf(
  raw: FlagDefinitionJson,
  snapshot: ParsedSnapshot,
  context: FlagContext
): string | { reason: FlagReason } {
  const aggregation = raw.filters.aggregation_group_type_index ?? undefined
  if (aggregation === undefined) return context.distinctId
  if (aggregation !== snapshot.tenantGroupIndex) return { reason: 'fallback:unsupported' }
  return context.groups.tenant ?? { reason: 'fallback:no_tenant' }
}

/**
 * Evaluate a definition once its bucketing value is known: holdout first,
 * then the conditions in array order, the first match winning.
 * @param entry - The registry entry.
 * @param raw - The definition.
 * @param snapshot - The snapshot, for the matching version.
 * @param context - The context.
 * @param options - The evaluation options.
 * @param bucketingValue - The distinct id or the tenant group key.
 * @returns The evaluation.
 */
async function evaluateBucketed(
  entry: FlagEntry,
  raw: FlagDefinitionJson,
  snapshot: ParsedSnapshot,
  context: FlagContext,
  options: EvaluateOptions,
  bucketingValue: string
): Promise<FlagEvaluation> {
  const holdout = await getHoldoutVariant(raw.filters.holdout, bucketingValue)
  if (holdout !== undefined && HOLDOUT_VARIANT.test(holdout)) {
    return {
      value: entry.fallback,
      reason: 'holdout',
      holdoutVariant: holdout as `holdout-${number}`,
    }
  }

  const variants = raw.filters.multivariate?.variants ?? []
  const state: { hash: number | undefined; hasPropertyMatch: boolean } = {
    hash: undefined,
    hasPropertyMatch: false,
  }
  for (const [index, condition] of raw.filters.groups.entries()) {
    const properties = condition.properties ?? []
    const isMatch = properties.every((property) =>
      isFlagPropertyMatch(property, context, snapshot.propertyMatchingVersion)
    )
    if (!isMatch) continue
    state.hasPropertyMatch = true
    state.hash ??= await getFeatureFlagHash(raw.key, bucketingValue)
    // In rollout when hash <= rollout / 100; a null rollout is 100 %.
    if (state.hash > (condition.rollout_percentage ?? 100) / 100) continue
    if (variants.length === 0) return matchedResult(entry, raw, index, undefined, options)
    const override = variants.some((variant) => variant.key === condition.variant)
      ? (condition.variant ?? undefined)
      : undefined
    const variant = override ?? (await getFeatureFlagVariant(raw.key, bucketingValue, variants))
    return matchedResult(entry, raw, index, variant, options)
  }
  return fallback(entry, state.hasPropertyMatch ? 'out_of_rollout' : 'no_condition_match')
}

/**
 * Evaluate one registered flag (spec §4.4). In order: not configured, no
 * snapshot, missing from PostHog, unsupported and inactive each serve the
 * fallback. Bucketing follows the definition's aggregation (distinct id,
 * or the tenant group key for the snapshot's tenant index; no tenant serves
 * `fallback:no_tenant`). A holdout match serves the fallback with
 * `holdoutVariant`. Then conditions are walked in array order: every
 * property must match and the bucketing hash must be within the rollout; a
 * multivariate match takes the condition's variant override when it names a
 * flag variant, otherwise core's variant. A variant the registry does not
 * declare serves `fallback:unsupported` and calls `onUnknownVariant`. No
 * match serves the fallback with `out_of_rollout` when some condition's
 * properties matched, else `no_condition_match`. A value core cannot read
 * serves `fallback:inconclusive`.
 * @param entry - The registry entry.
 * @param snapshot - The current snapshot, or null when there is none.
 * @param context - The context.
 * @param options - Whether flags are configured, and the unknown-variant callback.
 * @returns The evaluation; never rejects.
 */
export async function evaluateFlag(
  entry: FlagEntry,
  snapshot: ParsedSnapshot | null,
  context: FlagContext,
  options: EvaluateOptions
): Promise<FlagEvaluation> {
  if (!options.isConfigured) return fallback(entry, 'fallback:unconfigured')
  if (snapshot === null) return fallback(entry, 'fallback:snapshot_missing')
  const definition = definitionOf(snapshot, entry.key)
  if (definition === undefined) return fallback(entry, 'fallback:flag_missing')
  if (definition.unsupported !== null || definition.raw === null) {
    return fallback(entry, 'fallback:unsupported')
  }
  if (!definition.active) return fallback(entry, 'fallback:inactive')
  try {
    return await evaluateDefinition(entry, definition.raw, snapshot, context, options)
  } catch (error) {
    if (!isInconclusiveMatchError(error))
      logger.warn('Flag evaluation threw', { key: entry.key, error })
    return fallback(entry, 'fallback:inconclusive')
  }
}
