/**
 * @file The feature-flag registry: every flag the code reads, declared once
 * with its kind, fallback, scope and the apps that receive it, and checked
 * when this module loads. `flags:sync` creates each one in PostHog; while a
 * flag is missing there, or PostHog is unreachable, it answers its fallback.
 * Also the closed set of traits a flag may target, and the snapshot
 * pipeline's limits.
 */
import type { FlagApp, FlagReason, FlagScope } from '@/types/flags'

/**
 * A flag key: snake_case, starting with a letter.
 */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * The longest flag key, in characters.
 */
export const FLAG_KEY_MAX = 64

/**
 * The fields every registry entry has.
 */
interface FlagEntryBase {
  key: string
  /**
   * What the flag gates; `flags:sync` uses it as the PostHog flag's name.
   */
  description: string
  scope: FlagScope
  /**
   * Whether the value is served to browser apps through the read endpoints.
   */
  client: boolean
  /**
   * The apps that receive the value; non-empty exactly when `client` is true.
   */
  apps: readonly FlagApp[]
  /**
   * Whether reads record an exposure. Only multivariate flags with `control`
   * first can be experiments.
   */
  experiment: boolean
}

/**
 * An on/off flag. It falls back to false.
 */
export interface BooleanFlagEntry extends FlagEntryBase {
  kind: 'boolean'
  fallback: false
}

/**
 * A flag with named variants. It falls back to `variants[0]`.
 */
export interface MultivariateFlagEntry extends FlagEntryBase {
  kind: 'multivariate'
  variants: readonly [string, ...string[]]
  fallback: string
}

/**
 * One registry entry.
 */
export type FlagEntry = BooleanFlagEntry | MultivariateFlagEntry

/**
 * Every rule one multivariate entry breaks.
 * @param entry - The entry.
 * @returns One message per broken rule.
 */
function multivariateProblems(entry: MultivariateFlagEntry): string[] {
  const variants = entry.variants as readonly string[]
  if (variants.length === 0) return ['has no variants']
  const problems: string[] = []
  const seen = new Set<string>()
  for (const variant of variants) {
    if (seen.has(variant)) problems.push(`has a duplicate variant ${variant}`)
    seen.add(variant)
  }
  if (entry.fallback !== variants[0]) problems.push('must fall back to variants[0]')
  if (entry.experiment && variants[0] !== 'control') {
    problems.push("is an experiment, so variants[0] must be 'control'")
  }
  return problems
}

/**
 * Every rule one entry breaks, the duplicate-key rule aside.
 * @param entry - The entry.
 * @returns One message per broken rule.
 */
function entryProblems(entry: FlagEntry): string[] {
  const problems: string[] = []
  if (!FLAG_KEY_PATTERN.test(entry.key)) problems.push('key must be snake_case')
  if (entry.key.length > FLAG_KEY_MAX) {
    problems.push(`key must be at most ${String(FLAG_KEY_MAX)} characters`)
  }
  if (entry.apps.length > 0 !== entry.client) {
    problems.push('must list apps exactly when client is true')
  }
  if (entry.kind === 'boolean') {
    if (entry.fallback as boolean) problems.push('is boolean, so it must fall back to false')
    if (entry.experiment) problems.push('is an experiment, and an experiment must be multivariate')
    return problems
  }
  return [...problems, ...multivariateProblems(entry)]
}

/**
 * Check the registry when it loads, so a bad entry stops the process at
 * boot and fails the unit tests: snake_case keys of at most `FLAG_KEY_MAX`
 * characters, no duplicate key, a boolean fallback of false, non-empty and
 * unique variants with `variants[0]` as the fallback, `apps` non-empty
 * exactly when `client` is true, and experiments multivariate with
 * `control` first (PostHog counts exposure only for string responses).
 * @param entries - The entries, written `as const` so their keys and variants stay literal.
 * @returns The same entries.
 * @throws {Error} Naming the first entry that breaks a rule and every rule it breaks.
 */
export function assertFlagRegistry<const T extends readonly FlagEntry[]>(entries: T): T {
  const keys = new Set<string>()
  for (const entry of entries) {
    const problems = entryProblems(entry)
    if (keys.has(entry.key)) problems.push(`duplicate key ${entry.key}`)
    keys.add(entry.key)
    if (problems.length > 0) {
      throw new Error(`Flag registry entry ${entry.key}: ${problems.join('; ')}`)
    }
  }
  return entries
}

/**
 * Every flag the code reads. Add an entry here, then run `pnpm flags:sync`
 * in each environment to create it in PostHog, inactive.
 */
export const FLAGS = assertFlagRegistry([
  {
    key: 'example_beta_page',
    description: 'Reference flag: the tenant Beta page and its API route',
    kind: 'boolean',
    fallback: false,
    scope: 'tenant',
    client: true,
    apps: ['react'],
    experiment: false,
  },
  {
    key: 'example_cta_experiment',
    description: 'Reference experiment: the getting-started call-to-action style',
    kind: 'multivariate',
    variants: ['control', 'bold'],
    fallback: 'control',
    scope: 'user',
    client: true,
    apps: ['react'],
    experiment: true,
  },
] as const)

/**
 * One registered entry, with its literal key and variants.
 */
type RegisteredFlag = (typeof FLAGS)[number]

/**
 * A registered flag's key. An unregistered key is a type error.
 */
export type FlagKey = RegisteredFlag['key']

/**
 * The key of a registered boolean flag.
 */
export type BooleanFlagKey = Extract<RegisteredFlag, { kind: 'boolean' }>['key']

/**
 * The key of a registered multivariate flag.
 */
export type MultivariateFlagKey = Extract<RegisteredFlag, { kind: 'multivariate' }>['key']

/**
 * The variants of the entry in `E` whose key is `K`.
 */
type VariantsOf<E, K> = E extends { key: K; variants: readonly (infer V)[] } ? V : never

/**
 * The variant union of one multivariate flag.
 */
export type VariantOf<K extends MultivariateFlagKey> = VariantsOf<RegisteredFlag, K>

/**
 * The value type of one flag: its variant union, or boolean.
 */
export type FlagValue<K extends FlagKey> = K extends MultivariateFlagKey ? VariantOf<K> : boolean

const ENTRIES_BY_KEY: ReadonlyMap<string, FlagEntry> = new Map(
  FLAGS.map((entry): [string, FlagEntry] => [entry.key, entry])
)

/**
 * The registry entry of a flag key, or undefined for a key that is not
 * registered (a PostHog flag the code does not read).
 * @param key - Any flag key.
 * @returns The entry, or undefined.
 */
export function findFlagEntry(key: string): FlagEntry | undefined {
  return ENTRIES_BY_KEY.get(key)
}

/**
 * The registry entry of a registered flag.
 * @param key - The key.
 * @returns The entry.
 * @throws {Error} When the key is not registered, which only an untyped caller can pass.
 */
export function flagEntry(key: FlagKey): FlagEntry {
  const entry = ENTRIES_BY_KEY.get(key)
  if (!entry) throw new Error(`Flag ${key} is not registered`)
  return entry
}

/**
 * The flags one app receives: `client` true and the app in `apps`.
 * @param app - The app.
 * @returns The entries, in registry order.
 */
export function clientFlagsFor(app: FlagApp): readonly FlagEntry[] {
  return FLAGS.filter((entry: FlagEntry) => entry.client && entry.apps.includes(app))
}

/**
 * A trait a flag condition may target.
 */
export type TraitName =
  'platform_role' | 'tenant_role' | 'app_env' | 'account_created_days' | 'tenant_created_days'

/**
 * One trait: where PostHog reads it (a person or the tenant group), what it
 * holds, and example values for the staff Traits panel.
 */
export interface FlagTrait {
  name: TraitName
  where: 'person' | 'group'
  description: string
  examples: readonly string[]
}

/**
 * The closed set of traits, passed at evaluation time only and never stored
 * as PostHog person or group properties. There is no app trait: a gate and
 * a page evaluated with different apps would disagree.
 */
export const FLAG_TRAITS: readonly FlagTrait[] = [
  {
    name: 'platform_role',
    where: 'person',
    description: "The user's platform (staff) role; none for a user who is not staff.",
    examples: ['none', 'viewer', 'editor', 'manager', 'admin', 'owner'],
  },
  {
    name: 'tenant_role',
    where: 'person',
    description:
      "The user's membership role in the tenant the flag is evaluated for; none with no tenant or no membership.",
    examples: ['owner', 'admin', 'manager', 'editor', 'viewer', 'none'],
  },
  {
    name: 'app_env',
    where: 'person',
    description: 'The deployment the server runs in (APP_ENV).',
    examples: ['local', 'dev', 'qa', 'prod'],
  },
  {
    name: 'account_created_days',
    where: 'person',
    description: 'Whole days since the user signed up, an integer of at least 0.',
    examples: ['0', '30', '365'],
  },
  {
    name: 'tenant_created_days',
    where: 'group',
    description:
      'Whole days since the tenant was created, an integer of at least 0; absent with no tenant.',
    examples: ['0', '90', '365'],
  },
]

/**
 * The person property keys a condition may name: the person traits and
 * PostHog's implicit `distinct_id`.
 */
export const FLAG_PERSON_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  ...FLAG_TRAITS.filter((trait) => trait.where === 'person').map((trait) => trait.name),
  'distinct_id',
])

/**
 * The group property keys a condition may name: the tenant traits and
 * PostHog's implicit `$group_key`.
 */
export const FLAG_GROUP_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  ...FLAG_TRAITS.filter((trait) => trait.where === 'group').map((trait) => trait.name),
  '$group_key',
])

/**
 * The reason code PostHog's remote `/flags` reports for each of our
 * reasons, for the staff inspector and the golden tests; null where PostHog
 * has none (an inactive flag is absent from its answer, and the other
 * fallbacks are express's own).
 */
export const FLAG_REASON_POSTHOG_CODES: Readonly<Record<FlagReason, string | null>> = {
  condition_match: 'condition_match',
  out_of_rollout: 'out_of_rollout_bound',
  no_condition_match: 'no_condition_match',
  holdout: 'holdout_condition_value',
  'fallback:no_tenant': 'no_group_type',
  // eslint-disable-next-line unicorn/no-null -- PostHog omits an inactive flag
  'fallback:inactive': null,
  // eslint-disable-next-line unicorn/no-null -- express's own fallback
  'fallback:unconfigured': null,
  // eslint-disable-next-line unicorn/no-null -- express's own fallback
  'fallback:snapshot_missing': null,
  // eslint-disable-next-line unicorn/no-null -- express's own fallback
  'fallback:flag_missing': null,
  // eslint-disable-next-line unicorn/no-null -- express's own fallback
  'fallback:unsupported': null,
  // eslint-disable-next-line unicorn/no-null -- express's own fallback
  'fallback:inconclusive': null,
}

/**
 * How long one definitions fetch, body included, may take.
 */
export const FLAG_DEFINITIONS_TIMEOUT_MS = 5000

/**
 * The largest definitions body read; a larger one fails the fetch (56 flags
 * measured 28.6 kB).
 */
export const FLAG_DEFINITIONS_MAX_BYTES = 2 * 1024 * 1024

/**
 * How old a snapshot's `checkedAt` may be before the status calls it stale.
 */
export const FLAG_SNAPSHOT_STALE_MS = 600_000

/**
 * The window the status counts undeclared variants over, in minutes.
 */
export const FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES = 15

/**
 * The event an experiment exposure is recorded as; PostHog copies one with
 * a string response into `$experiment_exposure`.
 */
export const FLAG_EXPOSURE_EVENT = '$feature_flag_called'

/**
 * How long an exposure recorded with no session (a worker's read) is deduplicated, in seconds.
 */
export const FLAG_EXPOSURE_WORKER_TTL_SECONDS = 86_400
