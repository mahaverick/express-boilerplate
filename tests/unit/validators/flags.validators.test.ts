import { describe, expect, it, vi } from 'vitest'
import { parseExposureKeys } from '@/validators/flags.validators'

/**
 * Whether the react slice also carries a multivariate flag that is not an
 * experiment. The registry has none, so one test adds it.
 */
const registry = vi.hoisted(() => ({ hasPlainMultivariate: false }))

vi.mock('@/constants/flags.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants/flags.constants')>()
  return {
    ...actual,
    clientFlagsFor: (app: Parameters<typeof actual.clientFlagsFor>[0]) => {
      const entries = actual.clientFlagsFor(app)
      const experiment = entries.find((entry) => entry.experiment)
      return experiment && registry.hasPlainMultivariate
        ? [...entries, { ...experiment, key: 'plain_multivariate', experiment: false }]
        : entries
    },
  }
})

describe('parseExposureKeys', () => {
  it('accepts a registered experiment key for the app that reads it', () => {
    expect(parseExposureKeys({ keys: ['example_cta_experiment'] }, 'react')).toEqual([
      'example_cta_experiment',
    ])
  })

  it('refuses every key for apex, which registers no experiment', () => {
    expect(() => parseExposureKeys({ keys: ['example_cta_experiment'] }, 'apex')).toThrow(
      'Validation failed'
    )
  })

  it('refuses a boolean flag, duplicates, an empty list, more than 10 keys and extra fields', () => {
    for (const body of [
      { keys: ['example_beta_page'] },
      { keys: ['example_cta_experiment', 'example_cta_experiment'] },
      { keys: [] },
      { keys: Array.from({ length: 11 }, (_, index) => `k${String(index)}`) },
      { keys: ['example_cta_experiment'], app: 'react' },
    ]) {
      expect(() => parseExposureKeys(body, 'react')).toThrow('Validation failed')
    }
  })

  it('refuses a multivariate flag that is not an experiment', () => {
    registry.hasPlainMultivariate = true
    try {
      expect(() => parseExposureKeys({ keys: ['plain_multivariate'] }, 'react')).toThrow(
        'Validation failed'
      )
      expect(parseExposureKeys({ keys: ['example_cta_experiment'] }, 'react')).toEqual([
        'example_cta_experiment',
      ])
    } finally {
      registry.hasPlainMultivariate = false
    }
  })
})
