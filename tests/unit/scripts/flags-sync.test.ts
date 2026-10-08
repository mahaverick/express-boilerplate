/**
 * @file `pnpm flags:sync` against the fake PostHog on 127.0.0.1 (no
 * database, no Redis): the create bodies (inactive, 0 %, tagged, the tenant
 * group index, an even variant split), paging through the list, drift
 * printed and exit 2, a dry run that writes nothing, a missing `tenant`
 * group type refused before any create, a create race counted as present,
 * and exit 1 for a credential or API failure. Output is keys and counts
 * only. The key, project id and app host come from a mocked `getEnv()`.
 * Importing the script does not run it: it acts only as the entry module.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flagEntry } from '@/constants/flags.constants'
import { evenVariantSplit, FLAG_SYNC_TAG, runFlagsSync } from '@/scripts/flags-sync'
import { resetTenantGroupTypeIndexCache } from '@/services/analytics/timeline-group-index.service'
import {
  startFakePosthog,
  type FakePosthog,
  type FakePosthogFeatureFlag,
} from '../../helpers/fake-posthog'

const target = vi.hoisted((): { host: string; key: string | undefined } => ({
  host: 'http://127.0.0.1:1',
  key: 'phx_test_key_not_real',
}))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_APP_HOST: target.host,
      POSTHOG_PERSONAL_API_KEY: target.key,
      POSTHOG_PROJECT_ID: 4321,
    }),
  }
})

const fake: { posthog?: FakePosthog } = {}

/**
 * The running fake.
 * @returns It.
 */
function posthog(): FakePosthog {
  if (!fake.posthog) throw new Error('the fake PostHog is not running')
  return fake.posthog
}

/**
 * A flag already in the project.
 * @param key - Its key.
 * @param filters - Its filters.
 * @returns The list entry.
 */
function existing(key: string, filters: Record<string, unknown>): FakePosthogFeatureFlag {
  return {
    id: posthog().featureFlags.length + 1,
    key,
    name: key,
    active: true,
    deleted: false,
    tags: [],
    filters,
    created_by: { email: 'creator@example.test' },
  }
}

/**
 * Both reference flags, exactly as the registry declares them, with the
 * tenant group at index 2.
 * @returns The two list entries.
 */
function inSync(): FakePosthogFeatureFlag[] {
  return [
    existing('example_beta_page', { aggregation_group_type_index: 2, groups: [] }),
    existing('example_cta_experiment', {
      // eslint-disable-next-line unicorn/no-null -- PostHog's null means person aggregation
      aggregation_group_type_index: null,
      groups: [],
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'bold', rollout_percentage: 50 },
        ],
      },
    }),
  ]
}

/**
 * Run the script, capturing what it prints.
 * @param argv - Its arguments.
 * @returns The exit code, stdout and stderr.
 */
async function run(argv: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = []
  const errors: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
  const code = await runFlagsSync(argv)
  vi.restoreAllMocks()
  return { code, stdout: out.join(''), stderr: errors.join('') }
}

/**
 * The fake's create requests' paths.
 * @returns One path per POST.
 */
function createRequests(): string[] {
  return posthog()
    .requests.filter((request) => request.method === 'POST')
    .map((request) => request.path)
}

beforeAll(async () => {
  fake.posthog = await startFakePosthog()
  target.host = fake.posthog.url
})

afterEach(() => {
  vi.restoreAllMocks()
  resetTenantGroupTypeIndexCache()
  const current = posthog()
  current.requests.length = 0
  current.featureFlags = []
  current.featureFlagCreates.length = 0
  current.featureFlagsPageLimit = 200
  current.featureFlagsStatus = 200
  current.groupTypes = [{ group_type: 'tenant', group_type_index: 2 }]
  current.groupTypesStatus = 200
  current.onFeatureFlagCreate(undefined)
  target.key = 'phx_test_key_not_real'
})

afterAll(async () => {
  await fake.posthog?.close()
})

describe('evenVariantSplit', () => {
  it.each([
    [
      ['control', 'bold'],
      [50, 50],
    ],
    [
      ['control', 'a', 'b'],
      [34, 33, 33],
    ],
    [
      ['control', 'a', 'b', 'c', 'd', 'e'],
      [20, 16, 16, 16, 16, 16],
    ],
  ])('splits %j as %j, summing to 100', (variants, percentages) => {
    const split = evenVariantSplit(variants)

    expect(split.map((variant) => variant.rollout_percentage)).toEqual(percentages)
    expect(split.map((variant) => variant.key)).toEqual(variants)
  })
})

describe('runFlagsSync', () => {
  it('creates every missing flag inactive, at 0 %, tagged, and prints keys and counts', async () => {
    posthog().groupTypes = [{ group_type: 'tenant', group_type_index: 2 }]

    const { code, stdout } = await run(['--'])

    expect(code).toBe(0)
    expect(posthog().featureFlagCreates).toEqual([
      {
        key: 'example_beta_page',
        name: flagEntry('example_beta_page').description,
        active: false,
        tags: [FLAG_SYNC_TAG],
        filters: {
          groups: [{ properties: [], rollout_percentage: 0 }],
          aggregation_group_type_index: 2,
        },
      },
      {
        key: 'example_cta_experiment',
        name: flagEntry('example_cta_experiment').description,
        active: false,
        tags: [FLAG_SYNC_TAG],
        filters: {
          groups: [{ properties: [], rollout_percentage: 0 }],
          multivariate: {
            variants: [
              { key: 'control', rollout_percentage: 50 },
              { key: 'bold', rollout_percentage: 50 },
            ],
          },
        },
      },
    ])
    expect(stdout).toBe(
      'created example_beta_page\ncreated example_cta_experiment\nCreated 2, present 0, drifted 0.\n'
    )
    expect(stdout).not.toContain('creator@example.test')
  })

  it('pages through the list from the configured host, and creates nothing already there', async () => {
    posthog().featureFlags = [existing('other_flag', { groups: [] }), ...inSync()]
    posthog().featureFlagsPageLimit = 1

    const { code, stdout } = await run()

    expect(code).toBe(0)
    expect(createRequests()).toEqual([])
    expect(
      posthog()
        .requests.filter((request) => request.path.includes('feature_flags'))
        .map((request) => request.path)
    ).toEqual([
      '/api/projects/4321/feature_flags/?limit=200&offset=0',
      '/api/projects/4321/feature_flags/?limit=200&offset=1',
      '/api/projects/4321/feature_flags/?limit=200&offset=2',
    ])
    expect(stdout).toBe('Created 0, present 2, drifted 0.\n')
  })

  it('prints drift and exits 2, editing nothing', async () => {
    posthog().featureFlags = [
      // eslint-disable-next-line unicorn/no-null -- person aggregation on a tenant-scoped flag
      existing('example_beta_page', { aggregation_group_type_index: null, groups: [] }),
      existing('example_cta_experiment', { groups: [] }),
    ]

    const { code, stdout } = await run()

    expect(code).toBe(2)
    expect(createRequests()).toEqual([])
    expect(stdout).toContain('drift example_beta_page: scope\n')
    expect(stdout).toContain('drift example_cta_experiment: kind\n')
    expect(stdout).toContain('Created 0, present 0, drifted 2.\n')
  })

  it('names a variant drift', async () => {
    const [beta, cta] = inSync()
    if (!beta || !cta) throw new Error('setup: inSync returns both flags')
    cta.filters = {
      ...cta.filters,
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'loud', rollout_percentage: 50 },
        ],
      },
    }
    posthog().featureFlags = [beta, cta]

    const { code, stdout } = await run()

    expect(code).toBe(2)
    expect(stdout).toContain('drift example_cta_experiment: variants\n')
  })

  it('plans without writing on --dry-run', async () => {
    const { code, stdout } = await run(['--', '--dry-run'])

    expect(code).toBe(0)
    expect(createRequests()).toEqual([])
    expect(stdout).toBe(
      'would create example_beta_page\nwould create example_cta_experiment\nDry run: 2 to create, 0 present, 0 drifted.\n'
    )
  })

  it('exits 2 on a dry run that finds drift', async () => {
    posthog().featureFlags = [existing('example_cta_experiment', { groups: [] })]

    const { code, stdout } = await run(['--dry-run'])

    expect(code).toBe(2)
    expect(createRequests()).toEqual([])
    expect(stdout).toContain('Dry run: 1 to create, 0 present, 1 drifted.\n')
  })

  it('does not count a drifted flag as both present and drifted (counts sum to the registry)', async () => {
    const [beta, cta] = inSync()
    if (!beta || !cta) throw new Error('setup: inSync returns both flags')
    posthog().featureFlags = [
      // eslint-disable-next-line unicorn/no-null -- person aggregation on a tenant-scoped flag: drift
      { ...beta, filters: { aggregation_group_type_index: null, groups: [] } },
      cta,
    ]
    const { code, stdout } = await run()
    expect(code).toBe(2)
    expect(stdout).toContain('Created 0, present 1, drifted 1.')
  })

  it('exits 1 naming the group types when they cannot be read', async () => {
    posthog().groupTypesStatus = 500
    const { code, stderr } = await run()
    expect(code).toBe(1)
    expect(stderr).toBe('Could not read PostHog group types\n')
    expect(createRequests()).toEqual([])
  })

  it('treats a soft-deleted flag in the list as missing and creates it', async () => {
    const [beta, cta] = inSync()
    if (!beta || !cta) throw new Error('setup: inSync returns both flags')
    posthog().featureFlags = [{ ...beta, deleted: true }, cta]
    const { code } = await run()
    expect(code).toBe(0)
    expect(
      posthog().featureFlagCreates.map((created) => (created as { key?: string }).key)
    ).toEqual(['example_beta_page'])
  })

  it('exits 1 when the list never ends (MAX_PAGES)', async () => {
    posthog().featureFlagsPageLimit = 1
    posthog().featureFlags = Array.from({ length: 51 }, (_, index) =>
      existing(`other_${String(index)}`, { groups: [] })
    )
    const { code, stderr } = await run()
    expect(code).toBe(1)
    expect(stderr).toBe('PostHog flag list did not end\n')
  })

  it('refuses before creating anything when a tenant-scoped flag needs a missing tenant group type', async () => {
    posthog().groupTypes = []

    const { code, stderr } = await run()

    expect(code).toBe(1)
    expect(createRequests()).toEqual([])
    expect(stderr).toContain('no "tenant" group type')
  })

  it('counts a create that lost a race as present', async () => {
    posthog().onFeatureFlagCreate((body) =>
      body.key === 'example_cta_experiment'
        ? {
            status: 400,
            json: { type: 'validation_error', code: 'unique', attr: 'key', detail: 'exists' },
          }
        : undefined
    )

    const { code, stdout } = await run()

    expect(code).toBe(0)
    expect(stdout).toContain('present example_cta_experiment\n')
    expect(stdout).toContain('Created 1, present 1, drifted 0.')
  })

  it('creates the missing flag and reports the drifted one on the same run, exiting 2', async () => {
    posthog().featureFlags = [existing('example_cta_experiment', { groups: [] })]

    const { code, stdout } = await run()

    expect(code).toBe(2)
    expect(
      posthog().featureFlagCreates.map((created) => (created as { key?: string }).key)
    ).toEqual(['example_beta_page'])
    expect(stdout).toBe(
      'drift example_cta_experiment: kind\ncreated example_beta_page\nCreated 1, present 0, drifted 1.\n'
    )
  })

  it('counts a create that lost a race as present beside a drifted flag', async () => {
    posthog().featureFlags = [existing('example_cta_experiment', { groups: [] })]
    posthog().onFeatureFlagCreate(() => ({
      status: 400,
      json: { type: 'validation_error', code: 'unique', attr: 'key', detail: 'exists' },
    }))

    const { code, stdout } = await run()

    expect(code).toBe(2)
    expect(stdout).toBe(
      'drift example_cta_experiment: kind\npresent example_beta_page\nCreated 0, present 1, drifted 1.\n'
    )
  })

  it('exits 1 on any other refused create, naming the status and code only', async () => {
    posthog().onFeatureFlagCreate(() => ({
      status: 400,
      json: { type: 'validation_error', code: 'invalid_input', attr: 'tags', detail: 'secret' },
    }))

    const { code, stderr } = await run()

    expect(code).toBe(1)
    expect(stderr).toBe('Could not create example_beta_page: HTTP 400 invalid_input\n')
  })

  it('exits 1 when the list is refused, as with a key that lacks feature_flag:read', async () => {
    posthog().featureFlagsStatus = 403

    const { code, stderr } = await run()

    expect(code).toBe(1)
    expect(stderr).toBe('Could not list PostHog feature flags: HTTP 403\n')
  })

  it('exits 1 without a personal key, before any request', async () => {
    target.key = undefined

    const { code, stderr } = await run()

    expect(code).toBe(1)
    expect(stderr).toContain('POSTHOG_PERSONAL_API_KEY')
    expect(posthog().requests).toEqual([])
  })

  it('exits 1 on an unknown argument, before any request', async () => {
    const { code, stderr } = await run(['--force'])

    expect(code).toBe(1)
    expect(stderr).toBe('Usage: pnpm flags:sync [-- --dry-run]\n')
    expect(posthog().requests).toEqual([])
  })
})
