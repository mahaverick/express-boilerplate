/**
 * @file isAnalyticsEnabled, isErrorTrackingEnabled, isPosthogApiEnabled, posthogAssetsHost,
 * posthogAppHost, isFlagsEnabled and posthogFlagUrl, which are pure
 * functions of the environment slice they are given.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  isAnalyticsEnabled,
  isErrorTrackingEnabled,
  isFlagsEnabled,
  isPosthogApiEnabled,
  posthogAppHost,
  posthogAssetsHost,
  posthogFlagUrl,
} from '@/configs/analytics.config'

describe('isAnalyticsEnabled', () => {
  it('is on only when a project key is set', () => {
    expect(isAnalyticsEnabled({ POSTHOG_PROJECT_KEY: 'phc_test_key_not_real' })).toBe(true)
    expect(isAnalyticsEnabled({ POSTHOG_PROJECT_KEY: undefined })).toBe(false)
  })

  it('is off under the test environment, which sets no key', () => {
    expect(isAnalyticsEnabled()).toBe(false)
  })
})

describe('posthogAssetsHost', () => {
  it('derives the EU assets host from an eu. ingest host', () => {
    expect(
      posthogAssetsHost({
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        POSTHOG_ASSETS_HOST: undefined,
      })
    ).toBe('https://eu-assets.i.posthog.com')
  })

  it('derives the US assets host from any other ingest host', () => {
    for (const host of ['https://us.i.posthog.com', 'https://posthog.example.test']) {
      expect(posthogAssetsHost({ POSTHOG_HOST: host, POSTHOG_ASSETS_HOST: undefined })).toBe(
        'https://us-assets.i.posthog.com'
      )
    }
  })

  it('does not mistake a host that merely contains "eu." for an EU host', () => {
    expect(
      posthogAssetsHost({
        POSTHOG_HOST: 'https://posthog.eu.example.test',
        POSTHOG_ASSETS_HOST: undefined,
      })
    ).toBe('https://us-assets.i.posthog.com')
  })

  it('uses POSTHOG_ASSETS_HOST when set, without a trailing slash', () => {
    expect(
      posthogAssetsHost({
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        POSTHOG_ASSETS_HOST: 'http://127.0.0.1:9100/',
      })
    ).toBe('http://127.0.0.1:9100')
  })
})

describe('isPosthogApiEnabled', () => {
  it('is on only when both the personal key and the project id are set', () => {
    expect(
      isPosthogApiEnabled({
        POSTHOG_PERSONAL_API_KEY: 'phx_test_key_not_real',
        POSTHOG_PROJECT_ID: 1,
      })
    ).toBe(true)
    expect(
      isPosthogApiEnabled({
        POSTHOG_PERSONAL_API_KEY: 'phx_test_key_not_real',
        POSTHOG_PROJECT_ID: undefined,
      })
    ).toBe(false)
    expect(
      isPosthogApiEnabled({ POSTHOG_PERSONAL_API_KEY: undefined, POSTHOG_PROJECT_ID: 1 })
    ).toBe(false)
  })

  it('is off under the test environment, which sets neither', () => {
    expect(isPosthogApiEnabled()).toBe(false)
  })
})

describe('posthogAppHost', () => {
  it('derives the EU app host from an eu. ingest host', () => {
    expect(
      posthogAppHost({ POSTHOG_HOST: 'https://eu.i.posthog.com', POSTHOG_APP_HOST: undefined })
    ).toBe('https://eu.posthog.com')
  })

  it('derives the US app host from any other ingest host', () => {
    for (const host of [
      'https://us.i.posthog.com',
      'https://posthog.example.test',
      'https://posthog.eu.example.test',
    ]) {
      expect(posthogAppHost({ POSTHOG_HOST: host, POSTHOG_APP_HOST: undefined })).toBe(
        'https://us.posthog.com'
      )
    }
  })

  it('uses POSTHOG_APP_HOST when set, without a trailing slash', () => {
    expect(
      posthogAppHost({
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        POSTHOG_APP_HOST: 'https://posthog.example.test/',
      })
    ).toBe('https://posthog.example.test')
    expect(
      posthogAppHost({
        POSTHOG_HOST: 'https://us.i.posthog.com',
        POSTHOG_APP_HOST: 'http://127.0.0.1:9100',
      })
    ).toBe('http://127.0.0.1:9100')
  })
})

describe('isErrorTrackingEnabled', () => {
  it('is on only with a project key and the switch on', () => {
    const key = 'phc_test_key_not_real'
    expect(isErrorTrackingEnabled({ POSTHOG_PROJECT_KEY: key, ERROR_TRACKING_ENABLED: true })).toBe(
      true
    )
    expect(
      isErrorTrackingEnabled({ POSTHOG_PROJECT_KEY: key, ERROR_TRACKING_ENABLED: false })
    ).toBe(false)
    expect(
      isErrorTrackingEnabled({ POSTHOG_PROJECT_KEY: undefined, ERROR_TRACKING_ENABLED: true })
    ).toBe(false)
  })

  it('is off under the test environment', () => {
    expect(isErrorTrackingEnabled()).toBe(false)
  })
})

describe('isFlagsEnabled', () => {
  it('is on only when both the project key and the feature flags key are set', () => {
    expect(
      isFlagsEnabled({
        POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
        POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real',
      })
    ).toBe(true)
    expect(
      isFlagsEnabled({
        POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
        POSTHOG_FEATURE_FLAGS_KEY: undefined,
      })
    ).toBe(false)
    expect(
      isFlagsEnabled({
        POSTHOG_PROJECT_KEY: undefined,
        POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real',
      })
    ).toBe(false)
  })

  it('is off under the test environment, which sets neither', () => {
    expect(isFlagsEnabled()).toBe(false)
  })

  it.each([
    { POSTHOG_PROJECT_KEY: undefined, POSTHOG_FEATURE_FLAGS_KEY: undefined },
    { POSTHOG_PROJECT_KEY: 'phc_test_key_not_real', POSTHOG_FEATURE_FLAGS_KEY: undefined },
    { POSTHOG_PROJECT_KEY: undefined, POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real' },
    {
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_FEATURE_FLAGS_KEY: 'phs_test_key_not_real',
    },
  ])('implies isAnalyticsEnabled, which the analytics Worker gate relies on (%o)', (env) => {
    expect(!isFlagsEnabled(env) || isAnalyticsEnabled(env)).toBe(true)
  })
})

describe('posthogFlagUrl', () => {
  it("links a flag to its page under the project, on the region's app host", () => {
    expect(
      posthogFlagUrl(931_750, {
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        POSTHOG_APP_HOST: undefined,
        POSTHOG_PROJECT_ID: 4321,
      })
    ).toBe('https://eu.posthog.com/project/4321/feature_flags/931750')
  })

  it.each([0, -1, 1.5, NaN])(
    'is null for %s, which is no PostHog flag id (a malformed definition has 0)',
    (flagId) => {
      expect(
        posthogFlagUrl(flagId, {
          POSTHOG_HOST: 'https://us.i.posthog.com',
          POSTHOG_APP_HOST: undefined,
          POSTHOG_PROJECT_ID: 4321,
        })
      ).toBeNull()
    }
  )

  it('is null without a project id', () => {
    expect(
      posthogFlagUrl(1, {
        POSTHOG_HOST: 'https://us.i.posthog.com',
        POSTHOG_APP_HOST: undefined,
        POSTHOG_PROJECT_ID: undefined,
      })
    ).toBeNull()
  })
})
