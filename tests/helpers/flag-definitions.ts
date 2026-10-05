/**
 * @file Flag definitions for the flag tests, in the shape PostHog's
 * `/flags/definitions` answers with (one project, `tenant` at group index 0),
 * and `loadFlagDefinitions`, which runs them through the real parser and
 * snapshot store and waits until this process's replica holds them. The
 * caller starts the replica with `startFlagSnapshot()` first. Every
 * definition is hash-free: a rollout of 100 % or 0 %, a condition `variant`
 * override, and a holdout excluding 100 %, so an answer never depends on
 * which user or tenant the test created.
 */
import { randomUUID } from 'node:crypto'
import { getFlagSnapshot, writeFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import { parseDefinitionsResponse } from '@/validators/flag-definition.validators'
import { waitUntil } from './timing'

/**
 * The `tenant` group type's index in every test project.
 */
export const TEST_TENANT_GROUP_INDEX = 0

const ids = { next: 9000 }

/**
 * A definition as PostHog sends it.
 */
export type TestFlagDefinition = Record<string, unknown>

/**
 * A definition with PostHog's defaults: active, one condition with no
 * properties at `rolloutPercentage`, aggregated on the person unless
 * `groupIndex` is given.
 * @param key - The flag key.
 * @param options - What differs from the defaults.
 * @param options.active - Whether the flag is on in PostHog; defaults to true.
 * @param options.rolloutPercentage - The condition's rollout; defaults to 100.
 * @param options.groupIndex - The aggregation group index; null (the person) by default.
 * @param options.filters - Extra `filters` keys, merged over the defaults.
 * @returns The definition.
 */
export function flagDefinition(
  key: string,
  options: {
    active?: boolean
    rolloutPercentage?: number
    groupIndex?: number | null
    filters?: Record<string, unknown>
  } = {}
): TestFlagDefinition {
  // eslint-disable-next-line unicorn/no-null -- PostHog sends JSON null for a person-aggregated flag
  const groupIndex = options.groupIndex ?? null
  ids.next += 1
  return {
    id: ids.next,
    key,
    name: key,
    team_id: 1,
    version: 1,
    active: options.active ?? true,
    deleted: false,
    ensure_experience_continuity: false,
    has_experiment: false,
    evaluation_runtime: 'all',
    bucketing_identifier: 'distinct_id',
    evaluation_contexts: [],
    filters: {
      aggregation_group_type_index: groupIndex,
      groups: [
        {
          aggregation_group_type_index: groupIndex,
          properties: [],
          rollout_percentage: options.rolloutPercentage ?? 100,
        },
      ],
      ...options.filters,
    },
  }
}

/**
 * `example_beta_page` (tenant-scoped, boolean), rolled out to everyone or no one.
 * @param isOn - True for 100 %, false for 0 %.
 * @returns The definition.
 */
export function betaPageDefinition(isOn: boolean): TestFlagDefinition {
  return flagDefinition('example_beta_page', {
    rolloutPercentage: isOn ? 100 : 0,
    groupIndex: TEST_TENANT_GROUP_INDEX,
  })
}

/**
 * `example_cta_experiment` (user-scoped, `control`/`bold`): every user gets
 * `variant`, or, with `holdoutId`, every user is in that holdout, or, with
 * `rolloutPercentage` 0, no user is in the rollout.
 * @param options - The variant everyone gets, an optional holdout id and the rollout.
 * @param options.variant - The variant the one condition forces.
 * @param options.holdoutId - A holdout excluding 100 % of users.
 * @param options.rolloutPercentage - The condition's rollout; defaults to 100.
 * @returns The definition.
 */
export function ctaExperimentDefinition(
  options: { variant?: 'control' | 'bold'; holdoutId?: number; rolloutPercentage?: number } = {}
): TestFlagDefinition {
  return flagDefinition('example_cta_experiment', {
    filters: {
      groups: [
        {
          // eslint-disable-next-line unicorn/no-null -- a person-aggregated condition
          aggregation_group_type_index: null,
          properties: [],
          rollout_percentage: options.rolloutPercentage ?? 100,
          variant: options.variant ?? 'bold',
        },
      ],
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'bold', rollout_percentage: 50 },
        ],
      },
      ...(options.holdoutId !== undefined && {
        holdout: { id: options.holdoutId, exclusion_percentage: 100 },
      }),
    },
  })
}

/**
 * Parse `definitions` as one `/flags/definitions` answer, store the snapshot
 * and wait until this replica holds it.
 * @param definitions - The flags PostHog would send.
 * @returns Resolves once `getFlagSnapshot()` returns the new snapshot.
 */
export async function loadFlagDefinitions(definitions: TestFlagDefinition[]): Promise<void> {
  const etag = `W/"${randomUUID()}"`
  const body = {
    flags: definitions,
    group_type_mapping: { [String(TEST_TENANT_GROUP_INDEX)]: 'tenant' },
    cohorts: {},
    property_matching_version: 1,
    minimal_flag_called_events: false,
  }
  await writeFlagSnapshot(parseDefinitionsResponse(body, etag, new Date()))
  await waitUntil(() => getFlagSnapshot()?.etag === etag, {
    message: 'this replica loaded the test flag snapshot',
  })
}
