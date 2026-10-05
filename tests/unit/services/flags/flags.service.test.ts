/**
 * @file The flags service over a mocked snapshot: the client slices,
 * `isEnabled` and `variantOf`, which experiments record exposure and from
 * where, the unconfigured fallbacks and the undeclared-variant report.
 * Exposure recording itself is mocked here and tested against the real
 * outbox in tests/integration/services/flags/flag-exposure.service.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isFlagsEnabled } from '@/configs/analytics.config'
import { recordUnknownVariant } from '@/services/flags/flag-counters.service'
import { recordExposure } from '@/services/flags/flag-exposure.service'
import { getFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import {
  evaluateAll,
  evaluateKey,
  flagsFor,
  isEnabled,
  variantOf,
} from '@/services/flags/flags.service'
import type { FlagContext } from '@/types/flags'
import { parseDefinitionsResponse } from '@/validators/flag-definition.validators'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isFlagsEnabled: vi.fn(() => true) }
})
vi.mock('@/services/flags/flag-snapshot.service', () => ({ getFlagSnapshot: vi.fn() }))
vi.mock('@/services/flags/flag-exposure.service', () => ({ recordExposure: vi.fn() }))
vi.mock('@/services/flags/flag-counters.service', () => ({ recordUnknownVariant: vi.fn() }))

// eslint-disable-next-line unicorn/no-null -- the context's contract uses null
const NONE = null
const TENANT_ID = '0199b000-0000-7000-8000-000000000002'

const TENANT_CONTEXT: FlagContext = {
  distinctId: '0199b000-0000-7000-8000-000000000001',
  groups: { tenant: TENANT_ID },
  personProps: {
    platform_role: 'none',
    tenant_role: 'owner',
    app_env: 'local',
    account_created_days: 3,
  },
  groupProps: { tenant: { tenant_created_days: 3 } },
  tenantId: TENANT_ID,
  sessionId: 'session-1',
}

const TENANTLESS_CONTEXT: FlagContext = {
  ...TENANT_CONTEXT,
  groups: {},
  groupProps: {},
  tenantId: NONE,
}

/**
 * A definitions body holding both reference flags, fully rolled out, with
 * the experiment forced to one variant.
 * @param variant - The variant every user gets.
 * @param variants - The variants PostHog declares.
 * @returns The snapshot.
 */
function snapshotWith(variant: string, variants: string[] = ['control', 'bold']) {
  const base = {
    active: true,
    deleted: false,
    ensure_experience_continuity: false,
    bucketing_identifier: 'distinct_id',
    evaluation_contexts: [],
  }
  return parseDefinitionsResponse(
    {
      flags: [
        {
          ...base,
          id: 1,
          key: 'example_beta_page',
          filters: {
            aggregation_group_type_index: 0,
            groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 100 }],
          },
        },
        {
          ...base,
          id: 2,
          key: 'example_cta_experiment',
          filters: {
            groups: [{ properties: [], rollout_percentage: 100, variant }],
            multivariate: {
              variants: variants.map((key, index) => ({
                key,
                rollout_percentage: index === 0 ? 100 : 0,
              })),
            },
          },
        },
      ],
      group_type_mapping: { '0': 'tenant' },
      property_matching_version: 1,
    },
    NONE,
    new Date('2026-10-05T12:00:00.000Z')
  )
}

beforeEach(() => {
  vi.mocked(isFlagsEnabled).mockReturnValue(true)
  vi.mocked(getFlagSnapshot).mockReturnValue(snapshotWith('bold'))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('flagsFor', () => {
  it('evaluates every registered flag without an app', async () => {
    await expect(flagsFor(TENANT_CONTEXT)).resolves.toEqual({
      example_beta_page: true,
      example_cta_experiment: 'bold',
    })
  })

  it("returns only an app's client flags", async () => {
    await expect(flagsFor(TENANT_CONTEXT, { app: 'react' })).resolves.toEqual({
      example_beta_page: true,
      example_cta_experiment: 'bold',
    })
    await expect(flagsFor(TENANT_CONTEXT, { app: 'apex' })).resolves.toEqual({})
  })

  it('serves a tenant flag its fallback with no tenant', async () => {
    await expect(flagsFor(TENANTLESS_CONTEXT, { app: 'react' })).resolves.toEqual({
      example_beta_page: false,
      example_cta_experiment: 'bold',
    })
  })

  it('serves every fallback while flags are not configured, and never records exposure', async () => {
    vi.mocked(isFlagsEnabled).mockReturnValue(false)
    await expect(flagsFor(TENANT_CONTEXT)).resolves.toEqual({
      example_beta_page: false,
      example_cta_experiment: 'control',
    })
    expect(recordExposure).not.toHaveBeenCalled()
  })
})

describe('isEnabled, variantOf and evaluateKey', () => {
  it('reads a boolean flag without recording exposure', async () => {
    await expect(isEnabled(TENANT_CONTEXT, 'example_beta_page')).resolves.toBe(true)
    await expect(isEnabled(TENANTLESS_CONTEXT, 'example_beta_page')).resolves.toBe(false)
    expect(recordExposure).not.toHaveBeenCalled()
  })

  it('reads an experiment and records exposure from the server by default', async () => {
    await expect(variantOf(TENANT_CONTEXT, 'example_cta_experiment')).resolves.toBe('bold')
    expect(recordExposure).toHaveBeenCalledWith(
      TENANT_CONTEXT,
      'example_cta_experiment',
      { value: 'bold', reason: 'condition_match', conditionIndex: 0 },
      'server'
    )
  })

  it('records exposure with the origin given, and none when told not to', async () => {
    await variantOf(TENANT_CONTEXT, 'example_cta_experiment', { exposure: 'react' })
    expect(vi.mocked(recordExposure).mock.calls[0]?.[3]).toBe('react')
    vi.mocked(recordExposure).mockClear()
    await variantOf(TENANT_CONTEXT, 'example_cta_experiment', { exposure: false })
    expect(recordExposure).not.toHaveBeenCalled()
  })

  it('serves the fallback and reports a variant the registry does not declare', async () => {
    vi.mocked(getFlagSnapshot).mockReturnValue(snapshotWith('loud', ['loud', 'bold']))
    await expect(variantOf(TENANT_CONTEXT, 'example_cta_experiment')).resolves.toBe('control')
    expect(recordUnknownVariant).toHaveBeenCalledWith('example_cta_experiment')
  })

  it('evaluates one key with its reason', async () => {
    await expect(evaluateKey(TENANTLESS_CONTEXT, 'example_beta_page')).resolves.toEqual({
      value: false,
      reason: 'fallback:no_tenant',
    })
  })
})

describe('evaluateAll', () => {
  it('evaluates every registered flag with its reason, in registry order', async () => {
    await expect(evaluateAll(TENANT_CONTEXT)).resolves.toEqual([
      {
        key: 'example_beta_page',
        evaluation: { value: true, reason: 'condition_match', conditionIndex: 0 },
      },
      {
        key: 'example_cta_experiment',
        evaluation: { value: 'bold', reason: 'condition_match', conditionIndex: 0 },
      },
    ])
  })
})
