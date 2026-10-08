/**
 * @file `pnpm flags:sync [-- --dry-run]`: create every registered flag that
 * this environment's PostHog project lacks, inactive, at a 0 % rollout,
 * tagged `code-registry`. It never edits or deletes a flag; a registered
 * flag whose kind, variants or scope differ in PostHog is printed as
 * `drift <key>: <field>`. It reads with `POSTHOG_PERSONAL_API_KEY`
 * (`feature_flag:read`, plus `feature_flag:write` to create) and
 * `POSTHOG_PROJECT_ID`, and runs once per environment. Output is keys and
 * counts only, never a PostHog answer body, which names its creator. Exit
 * codes: 0 when clean or after creating, 2 on drift (a dry run too), 1 on a
 * credential, configuration or API failure.
 */
import { fileURLToPath } from 'node:url'
import { getEnv } from '@/configs/env.config'
import { FLAGS, type FlagEntry } from '@/constants/flags.constants'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import {
  posthogApi,
  posthogProjectPath,
  type PosthogApiResult,
} from '@/services/analytics/posthog-api.service'
import { tenantGroupTypeIndex } from '@/services/analytics/timeline-group-index.service'

const USAGE = 'Usage: pnpm flags:sync [-- --dry-run]'

/**
 * The tag every created flag carries. Projects can require one (the probe
 * project refuses an untagged create with 400), and it marks the flags the
 * registry owns.
 */
export const FLAG_SYNC_TAG = 'code-registry'

/**
 * The page size asked of PostHog's flag list.
 */
const PAGE_LIMIT = 200

/**
 * The most list pages read: 10,000 flags, far past any real project, so a
 * `next` that never ends can't loop forever.
 */
const MAX_PAGES = 50

/**
 * Exit codes.
 */
const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_DRIFT = 2

/**
 * A failure that ends the run with exit code 1 and its message on stderr.
 */
class SyncFailure extends Error {
  /**
   * Build one.
   * @param message - What went wrong, with no PostHog body in it.
   */
  constructor(message: string) {
    super(message)
    this.name = 'SyncFailure'
  }
}

/**
 * The fields sync reads from one flag in PostHog's list.
 */
interface ExistingFlag {
  key: string
  isMultivariate: boolean
  variantKeys: string[]
  aggregationIndex: number | null
}

/**
 * One variant of a multivariate create.
 */
interface VariantSplit {
  key: string
  rollout_percentage: number
}

/**
 * Split 100 % across the variants as integers, the remainder going to the
 * first (`control`): 50/50, 34/33/33. PostHog refuses any other sum.
 * @param variants - The registry's variant keys.
 * @returns Each variant with its percentage, summing to exactly 100.
 */
export function evenVariantSplit(variants: readonly string[]): VariantSplit[] {
  const share = Math.floor(100 / variants.length)
  const remainder = 100 - share * variants.length
  return variants.map((key, index) => ({
    key,
    rollout_percentage: index === 0 ? share + remainder : share,
  }))
}

/**
 * A failed call, in words with no body in them.
 * @param result - The call's outcome.
 * @returns `HTTP <status>`, `a timeout` or `a network error`.
 */
function describeFailure(result: Exclude<PosthogApiResult, { kind: 'ok' }>): string {
  if (result.kind === 'http_error') return `HTTP ${String(result.status)}`
  return result.kind === 'timeout' ? 'a timeout' : 'a network error'
}

/**
 * One list entry's sync fields, or undefined for a deleted or malformed entry.
 * @param raw - One element of the list's `results`.
 * @returns The fields.
 */
function existingFlagOf(raw: unknown): ExistingFlag | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { key, deleted, filters } = raw as { key?: unknown; deleted?: unknown; filters?: unknown }
  if (typeof key !== 'string' || deleted === true) return undefined
  const parsed = (typeof filters === 'object' && filters !== null ? filters : {}) as {
    aggregation_group_type_index?: unknown
    multivariate?: { variants?: { key?: unknown }[] } | null
  }
  const variants = parsed.multivariate?.variants ?? []
  const index = parsed.aggregation_group_type_index
  return {
    key,
    isMultivariate: parsed.multivariate !== undefined && parsed.multivariate !== null,
    variantKeys: variants.map((variant) => String(variant.key)),
    // eslint-disable-next-line unicorn/no-null -- PostHog's null means person aggregation
    aggregationIndex: typeof index === 'number' ? index : null,
  }
}

/**
 * The `offset` of the next page, read from PostHog's `next` URL. Only the
 * offset is taken: every page is fetched from the configured app host with
 * the key, never from a host an answer names.
 * @param next - The answer's `next`.
 * @param offset - The current page's offset.
 * @returns The next offset, or undefined on the last page.
 * @throws {SyncFailure} When `next` is not a URL with a larger offset.
 */
function nextOffsetOf(next: unknown, offset: number): number | undefined {
  if (next === null || next === undefined) return undefined
  const value = typeof next === 'string' ? URL.parse(next)?.searchParams.get('offset') : undefined
  const nextOffset = Number(value)
  if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
    throw new SyncFailure('PostHog answered the flag list with an unusable next page')
  }
  return nextOffset
}

/**
 * Every flag in the project, following the list's pages.
 * @returns The flags, by key.
 * @throws {SyncFailure} When a page fails, is malformed, or the pages never end.
 */
async function listExistingFlags(): Promise<Map<string, ExistingFlag>> {
  const flags = new Map<string, ExistingFlag>()
  let offset: number | undefined = 0
  let pages = 0
  while (offset !== undefined) {
    if (pages === MAX_PAGES) throw new SyncFailure('PostHog flag list did not end')
    pages += 1
    const result = await posthogApi('GET', posthogProjectPath('feature_flags/'), undefined, {
      query: { limit: String(PAGE_LIMIT), offset: String(offset) },
    })
    if (result.kind !== 'ok') {
      throw new SyncFailure(`Could not list PostHog feature flags: ${describeFailure(result)}`)
    }
    const { results, next } = (result.json ?? {}) as { results?: unknown; next?: unknown }
    if (!Array.isArray(results)) {
      throw new SyncFailure('PostHog answered the flag list in an unexpected shape')
    }
    for (const raw of results as unknown[]) {
      const flag = existingFlagOf(raw)
      if (flag) flags.set(flag.key, flag)
    }
    offset = nextOffsetOf(next, offset)
  }
  return flags
}

/**
 * The `tenant` group type's index, when the registry has a tenant-scoped flag.
 * @returns The index; undefined when PostHog has no `tenant` group type or no flag needs it.
 * @throws {SyncFailure} When PostHog can't be asked.
 */
async function tenantIndexIfNeeded(): Promise<number | undefined> {
  if (FLAGS.every((entry) => entry.scope !== 'tenant')) return undefined
  try {
    return await tenantGroupTypeIndex()
  } catch (error) {
    if (error instanceof TimelineUnavailableError) {
      throw new SyncFailure('Could not read PostHog group types')
    }
    throw error
  }
}

/**
 * The fields where PostHog's flag differs from its registry entry.
 * @param entry - The registry entry.
 * @param existing - The flag in PostHog.
 * @param tenantIndex - The `tenant` group type's index, if PostHog has one.
 * @returns `kind`, `variants` and/or `scope`, in that order.
 */
function driftOf(
  entry: FlagEntry,
  existing: ExistingFlag,
  tenantIndex: number | undefined
): string[] {
  const fields: string[] = []
  if (existing.isMultivariate !== (entry.kind === 'multivariate')) fields.push('kind')
  else if (
    entry.kind === 'multivariate' &&
    existing.variantKeys.join(',') !== entry.variants.join(',')
  ) {
    fields.push('variants')
  }
  const isScopeRight =
    entry.scope === 'user'
      ? existing.aggregationIndex === null
      : tenantIndex !== undefined && existing.aggregationIndex === tenantIndex
  if (!isScopeRight) fields.push('scope')
  return fields
}

/**
 * The create body for one missing flag: inactive, one release condition at
 * 0 %, tagged, aggregated on the tenant group for tenant scope, with an even
 * variant split for a multivariate flag.
 * @param entry - The registry entry.
 * @param tenantIndex - The `tenant` group type's index; required for tenant scope.
 * @returns The JSON body.
 */
function createBodyOf(entry: FlagEntry, tenantIndex: number | undefined): Record<string, unknown> {
  return {
    key: entry.key,
    name: entry.description,
    active: false,
    tags: [FLAG_SYNC_TAG],
    filters: {
      groups: [{ properties: [], rollout_percentage: 0 }],
      ...(entry.scope === 'tenant' && { aggregation_group_type_index: tenantIndex }),
      ...(entry.kind === 'multivariate' && {
        multivariate: { variants: evenVariantSplit(entry.variants) },
      }),
    },
  }
}

/**
 * Create one flag. A 400 `unique` means another run created it first, which
 * counts as present.
 * @param entry - The registry entry.
 * @param tenantIndex - The `tenant` group type's index.
 * @returns `created` or `present`.
 * @throws {SyncFailure} On any other failure, naming the status and PostHog's error code only.
 */
async function createFlag(
  entry: FlagEntry,
  tenantIndex: number | undefined
): Promise<'created' | 'present'> {
  const result = await posthogApi(
    'POST',
    posthogProjectPath('feature_flags/'),
    createBodyOf(entry, tenantIndex),
    { shouldReadErrorBody: true }
  )
  if (result.kind === 'ok') return 'created'
  const code =
    result.kind === 'http_error' ? (result.json as { code?: unknown } | undefined)?.code : undefined
  if (code === 'unique' && result.kind === 'http_error' && result.status === 400) return 'present'
  const suffix = typeof code === 'string' ? ` ${code}` : ''
  throw new SyncFailure(`Could not create ${entry.key}: ${describeFailure(result)}${suffix}`)
}

/**
 * Read the arguments.
 * @param argv - The arguments after the script path.
 * @returns Whether this is a dry run.
 * @throws {SyncFailure} On anything but pnpm's `--` and `--dry-run`.
 */
function isDryRunOf(argv: readonly string[]): boolean {
  const unknown = argv.filter((argument) => argument !== '--' && argument !== '--dry-run')
  if (unknown.length > 0) throw new SyncFailure(USAGE)
  return argv.includes('--dry-run')
}

/**
 * What a run will do: the registered flags PostHog lacks, and a
 * `drift <key>: <field>` line per field that differs on the ones it has.
 */
interface SyncPlan {
  missing: FlagEntry[]
  driftLines: string[]
  driftedKeys: number
}

/**
 * Compare the registry with PostHog's flags.
 * @param existing - PostHog's flags, by key.
 * @param tenantIndex - The `tenant` group type's index, if PostHog has one.
 * @returns The plan.
 */
function planSync(existing: Map<string, ExistingFlag>, tenantIndex: number | undefined): SyncPlan {
  const plan: SyncPlan = { missing: [], driftLines: [], driftedKeys: 0 }
  for (const entry of FLAGS) {
    const flag = existing.get(entry.key)
    if (flag === undefined) {
      plan.missing.push(entry)
      continue
    }
    const fields = driftOf(entry, flag, tenantIndex)
    if (fields.length > 0) plan.driftedKeys += 1
    plan.driftLines.push(...fields.map((field) => `drift ${entry.key}: ${field}`))
  }
  return plan
}

/**
 * Create every missing flag, printing each outcome.
 * @param missing - The flags to create.
 * @param tenantIndex - The `tenant` group type's index.
 * @returns How many were created (the rest were created concurrently).
 * @throws {SyncFailure} On the first create that fails.
 */
async function createMissing(
  missing: readonly FlagEntry[],
  tenantIndex: number | undefined
): Promise<number> {
  let created = 0
  for (const entry of missing) {
    const outcome = await createFlag(entry, tenantIndex)
    if (outcome === 'created') created += 1
    process.stdout.write(`${outcome} ${entry.key}\n`)
  }
  return created
}

/**
 * Sync the registry into this environment's PostHog project.
 * @param argv - The arguments after the script path: `--dry-run`, and pnpm's `--`.
 * @returns The exit code: 0 clean or created, 2 on drift, 1 on failure.
 */
export async function runFlagsSync(argv: readonly string[]): Promise<number> {
  try {
    const isDryRun = isDryRunOf(argv)
    const env = getEnv()
    if (env.POSTHOG_PERSONAL_API_KEY === undefined || env.POSTHOG_PROJECT_ID === undefined) {
      throw new SyncFailure('Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID to sync flags')
    }
    const existing = await listExistingFlags()
    const tenantIndex = await tenantIndexIfNeeded()
    const { missing, driftLines, driftedKeys } = planSync(existing, tenantIndex)
    for (const line of driftLines) process.stdout.write(`${line}\n`)
    if (tenantIndex === undefined && missing.some((entry) => entry.scope === 'tenant')) {
      throw new SyncFailure(
        'PostHog has no "tenant" group type; add it before syncing tenant-scoped flags'
      )
    }
    const exitCode = driftedKeys > 0 ? EXIT_DRIFT : EXIT_OK
    if (isDryRun) {
      for (const entry of missing) process.stdout.write(`would create ${entry.key}\n`)
      // Disjoint counts that add up to the registry: a drifted flag is not also present.
      const present = FLAGS.length - missing.length - driftedKeys
      process.stdout.write(
        `Dry run: ${String(missing.length)} to create, ${String(present)} present, ${String(driftedKeys)} drifted.\n`
      )
      return exitCode
    }
    const created = await createMissing(missing, tenantIndex)
    // A create that lost a race counts as present, beside the flags already in sync.
    const present = FLAGS.length - created - driftedKeys
    process.stdout.write(
      `Created ${String(created)}, present ${String(present)}, drifted ${String(driftedKeys)}.\n`
    )
    return exitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_FAILURE
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFlagsSync(process.argv.slice(2))
}
