/**
 * @file The shape of PostHog's `/flags/definitions` body, and the parse
 * into the snapshot express evaluates from. The body is untrusted input:
 * unknown flag-level fields are stripped (PostHog adds them often), a flag
 * that fails the schema is kept as `malformed` so it is never evaluated, and
 * every construct the evaluator cannot reproduce exactly marks the flag
 * unsupported (`detectUnsupported`), so it answers its registry fallback
 * instead of a half-evaluated value.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  findFlagEntry,
  FLAG_GROUP_PROPERTY_KEYS,
  FLAG_PERSON_PROPERTY_KEYS,
  FLAGS,
  type FlagEntry,
} from '@/constants/flags.constants'

/**
 * The version of the parse and detection rules. Bump it whenever
 * `detectUnsupported` or the schema changes what a definition parses to, so
 * every stored snapshot's fingerprint stops matching and the next
 * definitions run re-parses it (`flagRegistryFingerprint`).
 */
export const FLAG_PARSER_VERSION = 1

const FINGERPRINT_LENGTH = 16

/**
 * A stable hash of what a snapshot's `unsupported` verdicts depend on
 * besides PostHog's body: every registry entry's key, kind, variants and
 * scope, in registry order, and the parser version. A stored snapshot whose
 * fingerprint differs from the running one was parsed by other rules, so
 * the definitions job fetches it again without `If-None-Match`.
 * @param entries - The registry; defaults to `FLAGS`.
 * @param parserVersion - The parser version; defaults to `FLAG_PARSER_VERSION`.
 * @returns The first 16 hex characters of the sha256.
 */
export function flagRegistryFingerprint(
  entries: readonly FlagEntry[] = FLAGS,
  parserVersion: number = FLAG_PARSER_VERSION
): string {
  const registry = entries.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    // eslint-disable-next-line unicorn/no-null -- a boolean entry has no variants
    variants: entry.kind === 'multivariate' ? entry.variants : null,
    scope: entry.scope,
  }))
  return createHash('sha256')
    .update(JSON.stringify({ parserVersion, registry }))
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}

/**
 * The property operators `@posthog/core`'s `matchFeatureFlagProperty`
 * implements. A missing operator means `exact`.
 */
export const FLAG_OPERATORS: readonly string[] = [
  'exact',
  'is_not',
  'is_set',
  'is_not_set',
  'icontains',
  'not_icontains',
  'starts_with',
  'not_starts_with',
  'ends_with',
  'not_ends_with',
  'regex',
  'not_regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_date_before',
  'is_date_after',
  'semver_eq',
  'semver_neq',
  'semver_gt',
  'semver_gte',
  'semver_lt',
  'semver_lte',
  'semver_tilde',
  'semver_caret',
  'semver_wildcard',
]

const OPERATORS: ReadonlySet<string> = new Set(FLAG_OPERATORS)

/**
 * The `filters` keys the evaluator knows; any other makes the flag unsupported.
 */
const KNOWN_FILTER_KEYS: ReadonlySet<string> = new Set([
  'aggregation_group_type_index',
  'groups',
  'multivariate',
  'holdout',
  'payloads',
  'feature_enrollment',
  'super_groups',
])

/**
 * One condition property. `type` and `operator` are any string here, so an
 * unknown one parses and `detectUnsupported` names it.
 */
export const flagPropertySchema = z.object({
  key: z.string(),
  type: z.string().optional(),
  operator: z.string().nullish(),
  value: z.unknown(),
  group_type_index: z.number().int().nullish(),
  negation: z.boolean().optional(),
})

/**
 * One condition property, as validated.
 */
export type FlagPropertyJson = z.infer<typeof flagPropertySchema>

const conditionSchema = z.object({
  properties: z.array(flagPropertySchema).nullish(),
  rollout_percentage: z.number().nullish(),
  variant: z.string().nullish(),
  aggregation_group_type_index: z.number().int().nullish(),
})

const variantSchema = z.object({ key: z.string(), rollout_percentage: z.number() })

const filtersSchema = z
  .object({
    aggregation_group_type_index: z.number().int().nullish(),
    groups: z.array(conditionSchema).default([]),
    multivariate: z.object({ variants: z.array(variantSchema) }).nullish(),
    holdout: z.object({ id: z.number().int(), exclusion_percentage: z.number() }).nullish(),
    payloads: z.unknown().optional(),
    feature_enrollment: z.boolean().nullish(),
    super_groups: z.array(z.unknown()).nullish(),
  })
  .catchall(z.unknown())

/**
 * One flag of the definitions body. Fields not listed (`name`, `team_id`,
 * `version`, `has_experiment` and any PostHog adds) are stripped.
 */
export const flagDefinitionSchema = z.object({
  id: z.number().int(),
  key: z.string().min(1),
  active: z.boolean(),
  deleted: z.boolean().default(false),
  ensure_experience_continuity: z.boolean().nullish(),
  bucketing_identifier: z.string().nullish(),
  evaluation_contexts: z.array(z.unknown()).nullish(),
  evaluation_runtime: z.string().nullish(),
  filters: filtersSchema,
})

/**
 * One flag definition, as validated.
 */
export type FlagDefinitionJson = z.infer<typeof flagDefinitionSchema>

const definitionsResponseSchema = z.object({
  flags: z.array(z.unknown()),
  group_type_mapping: z.record(z.string(), z.string()).default({}),
  cohorts: z.unknown().optional(),
  property_matching_version: z.number().int().nullish(),
  minimal_flag_called_events: z.boolean().nullish(),
})

/**
 * Why a flag is not evaluated.
 */
export type UnsupportedConstruct =
  | 'experience_continuity'
  | 'bucketing_identifier'
  | 'evaluation_contexts'
  | 'unknown_filter'
  | 'early_access'
  | 'group_type'
  | 'cohort'
  | 'flag_dependency'
  | 'unknown_property_type'
  | 'unknown_operator'
  | 'is_not_set'
  | 'property_key'
  | 'malformed'
  | 'scope_drift'
  | 'kind_drift'

/**
 * One flag of the snapshot.
 */
export interface ParsedDefinition {
  key: string
  id: number
  active: boolean
  /**
   * The construct that keeps this flag from being evaluated, or null when it is evaluated.
   */
  unsupported: UnsupportedConstruct | null
  /**
   * The validated definition; null only for a flag that failed the schema (`malformed`).
   */
  raw: FlagDefinitionJson | null
}

/**
 * The parsed definitions every replica evaluates from, as stored in Redis.
 */
export interface ParsedSnapshot {
  /**
   * PostHog's weak ETag, stored verbatim and sent back as `If-None-Match`.
   */
  etag: string | null
  /**
   * When these definitions were fetched, as ISO 8601.
   */
  fetchedAt: string
  /**
   * When PostHog last confirmed them (a 200 or a 304), as ISO 8601.
   */
  checkedAt: string
  /**
   * The body's `property_matching_version`, passed to every property match.
   */
  propertyMatchingVersion: number | null
  /**
   * The group type index of `tenant` in `group_type_mapping`, or null when the project has none.
   */
  tenantGroupIndex: number | null
  /**
   * The `flagRegistryFingerprint` of the code that parsed it. Absent only in
   * a snapshot stored before fingerprints existed, which counts as a
   * mismatch.
   */
  fingerprint?: string
  /**
   * Every flag that is not deleted, by key, registered or not.
   */
  flags: Record<string, ParsedDefinition>
}

/**
 * A construct on the flag itself, before its conditions are read.
 * @param definition - The definition.
 * @returns The construct, or undefined.
 */
function flagLevelConstruct(definition: FlagDefinitionJson): UnsupportedConstruct | undefined {
  if (definition.ensure_experience_continuity === true) return 'experience_continuity'
  if ((definition.bucketing_identifier ?? 'distinct_id') !== 'distinct_id')
    return 'bucketing_identifier'
  if ((definition.evaluation_contexts ?? []).length > 0) return 'evaluation_contexts'
  if (Object.keys(definition.filters).some((key) => !KNOWN_FILTER_KEYS.has(key)))
    return 'unknown_filter'
  if (
    definition.filters.feature_enrollment === true ||
    (definition.filters.super_groups ?? []).length > 0
  ) {
    return 'early_access'
  }
  return undefined
}

/**
 * A group aggregation the evaluator cannot bucket on: an index other than
 * the tenant's (one missing from `group_type_mapping` included), or a
 * condition aggregated differently from the flag.
 * @param definition - The definition.
 * @param tenantGroupIndex - The tenant group type index, or null.
 * @returns `group_type`, or undefined.
 */
function aggregationConstruct(
  definition: FlagDefinitionJson,
  tenantGroupIndex: number | null
): UnsupportedConstruct | undefined {
  const aggregation = definition.filters.aggregation_group_type_index ?? undefined
  if (aggregation !== undefined && aggregation !== tenantGroupIndex) return 'group_type'
  const isMixed = definition.filters.groups.some(
    (condition) =>
      condition.aggregation_group_type_index !== undefined &&
      (condition.aggregation_group_type_index ?? undefined) !== aggregation
  )
  return isMixed ? 'group_type' : undefined
}

/**
 * A property the evaluator cannot match exactly as PostHog does. A person
 * property belongs to a person-aggregated flag and a group property, with
 * its own `group_type_index` naming the tenant type, to a tenant-aggregated
 * one; any other pairing is mixed targeting and is `group_type`.
 * @param property - The property.
 * @param isTenantAggregated - Whether the flag aggregates on a group type.
 * @param tenantGroupIndex - The tenant group type index, or null.
 * @returns The construct, or undefined.
 */
function propertyConstruct(
  property: FlagPropertyJson,
  isTenantAggregated: boolean,
  tenantGroupIndex: number | null
): UnsupportedConstruct | undefined {
  if (property.type === 'cohort') return 'cohort'
  if (property.type === 'flag') return 'flag_dependency'
  if (property.type !== 'person' && property.type !== 'group') return 'unknown_property_type'
  const operator = property.operator ?? 'exact'
  if (!OPERATORS.has(operator) || property.negation === true) return 'unknown_operator'
  if (operator === 'is_not_set') return 'is_not_set'
  if (property.type === 'person') {
    if (isTenantAggregated) return 'group_type'
    return FLAG_PERSON_PROPERTY_KEYS.has(property.key) ? undefined : 'property_key'
  }
  if (!isTenantAggregated) return 'group_type'
  const groupIndex = property.group_type_index ?? undefined
  if (groupIndex === undefined || groupIndex !== tenantGroupIndex) return 'group_type'
  return FLAG_GROUP_PROPERTY_KEYS.has(property.key) ? undefined : 'property_key'
}

/**
 * A condition variant that names no variant of the flag.
 * @param definition - The definition.
 * @returns `malformed`, or undefined.
 */
function variantConstruct(definition: FlagDefinitionJson): UnsupportedConstruct | undefined {
  const variants = new Set(
    (definition.filters.multivariate?.variants ?? []).map((variant) => variant.key)
  )
  const hasStrayVariant = definition.filters.groups.some(
    (condition) =>
      condition.variant !== undefined &&
      condition.variant !== null &&
      !variants.has(condition.variant)
  )
  return hasStrayVariant ? 'malformed' : undefined
}

/**
 * Where the definition disagrees with its registry entry: aggregation
 * against `scope` (null for `user`, the tenant index for `tenant`), or the
 * presence of variants against `kind`.
 * @param definition - The definition.
 * @param entry - The registry entry.
 * @returns `scope_drift` or `kind_drift`, or undefined.
 */
function registryConstruct(
  definition: FlagDefinitionJson,
  entry: FlagEntry
): UnsupportedConstruct | undefined {
  const isTenantAggregated =
    (definition.filters.aggregation_group_type_index ?? undefined) !== undefined
  if (isTenantAggregated !== (entry.scope === 'tenant')) return 'scope_drift'
  const isMultivariate = (definition.filters.multivariate?.variants ?? []).length > 0
  return isMultivariate === (entry.kind === 'multivariate') ? undefined : 'kind_drift'
}

/**
 * The first construct of spec §4.5 that keeps a flag from being evaluated:
 * flag-level settings (experience continuity, device bucketing, evaluation
 * contexts, an unknown `filters` key, early access), then a group
 * aggregation that is not the tenant's, then each property (cohort, flag
 * dependency, unknown type or operator, `is_not_set`, a key outside the
 * traits), then a stray condition variant, then disagreement with the
 * registry entry. Date and semver operators are supported, but no trait
 * holds a date or a version, so a condition using one is refused by its key.
 * @param definition - The validated definition.
 * @param entry - Its registry entry, or undefined for a flag the code does
 *   not declare (no scope or kind check).
 * @param tenantGroupIndex - The tenant group type index, or null when the project has none.
 * @returns The construct, or null when the flag can be evaluated.
 */
export function detectUnsupported(
  definition: FlagDefinitionJson,
  entry: FlagEntry | undefined,
  tenantGroupIndex: number | null
): UnsupportedConstruct | null {
  const isTenantAggregated =
    (definition.filters.aggregation_group_type_index ?? undefined) !== undefined
  const properties = definition.filters.groups.flatMap((condition) => condition.properties ?? [])
  const construct =
    flagLevelConstruct(definition) ??
    aggregationConstruct(definition, tenantGroupIndex) ??
    properties
      .map((property) => propertyConstruct(property, isTenantAggregated, tenantGroupIndex))
      .find((found) => found !== undefined) ??
    variantConstruct(definition) ??
    (entry === undefined ? undefined : registryConstruct(definition, entry))
  // eslint-disable-next-line unicorn/no-null -- the snapshot's contract is null for an evaluable flag
  return construct ?? null
}

/**
 * Whether a value is a plain object.
 * @param value - Anything.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The snapshot entry of a flag that failed the schema, when it at least has a key.
 * @param item - The raw flag.
 * @returns A `malformed` entry, or undefined for one with no key or marked deleted.
 */
function malformedDefinition(item: unknown): ParsedDefinition | undefined {
  if (!isRecord(item) || typeof item.key !== 'string' || item.key === '' || item.deleted === true) {
    return undefined
  }
  return {
    key: item.key,
    id: typeof item.id === 'number' ? item.id : 0,
    active: item.active === true,
    unsupported: 'malformed',
    // eslint-disable-next-line unicorn/no-null -- a malformed flag has no validated definition
    raw: null,
  }
}

/**
 * Parse one raw flag.
 * @param item - The raw flag.
 * @param tenantGroupIndex - The tenant group type index, or null.
 * @returns Its snapshot entry, or undefined for a deleted flag or one with no key.
 */
function parseDefinition(
  item: unknown,
  tenantGroupIndex: number | null
): ParsedDefinition | undefined {
  const result = flagDefinitionSchema.safeParse(item)
  if (!result.success) return malformedDefinition(item)
  const definition = result.data
  if (definition.deleted) return undefined
  return {
    key: definition.key,
    id: definition.id,
    active: definition.active,
    unsupported: detectUnsupported(definition, findFlagEntry(definition.key), tenantGroupIndex),
    raw: definition,
  }
}

/**
 * The `tenant` group type's index in `group_type_mapping`.
 * @param mapping - Index (as a string) to group type name.
 * @returns The index, or null when no group type is named `tenant`.
 */
function tenantIndexOf(mapping: Record<string, string>): number | null {
  const found = Object.entries(mapping).find(
    ([index, name]) => name === 'tenant' && /^\d+$/.test(index)
  )
  // eslint-disable-next-line unicorn/no-null -- the snapshot's contract is null for no tenant group type
  return found === undefined ? null : Number(found[0])
}

/**
 * Parse a `/flags/definitions` body into a snapshot. Each flag is parsed on
 * its own, so one bad flag never costs the rest. The map is built with
 * `Object.fromEntries`, so a remote key such as `__proto__` stays an own
 * property.
 * @param body - The parsed JSON body.
 * @param etag - The response's ETag header, verbatim, or null.
 * @param now - When it was fetched; also its `checkedAt`.
 * @returns The snapshot.
 * @throws {z.ZodError} When the body's top level is not the definitions shape.
 */
export function parseDefinitionsResponse(
  body: unknown,
  etag: string | null,
  now: Date
): ParsedSnapshot {
  const response = definitionsResponseSchema.parse(body)
  const tenantGroupIndex = tenantIndexOf(response.group_type_mapping)
  const entries = response.flags
    .map((item) => parseDefinition(item, tenantGroupIndex))
    .filter((parsed) => parsed !== undefined)
    .map((parsed): [string, ParsedDefinition] => [parsed.key, parsed])
  const at = now.toISOString()
  return {
    etag,
    fetchedAt: at,
    checkedAt: at,
    // eslint-disable-next-line unicorn/no-null -- the snapshot's contract is null for an absent version
    propertyMatchingVersion: response.property_matching_version ?? null,
    tenantGroupIndex,
    fingerprint: flagRegistryFingerprint(),
    flags: Object.fromEntries(entries),
  }
}
