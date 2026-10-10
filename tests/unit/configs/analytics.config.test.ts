/**
 * @file isAnalyticsEnabled, isErrorTrackingEnabled, isTimelineEnabled, posthogAssetsHost,
 * posthogAppHost, timelineLinks, isFlagsEnabled and posthogFlagUrl, which are pure
 * functions of the environment slice they are given.
 */
import { describe, expect, it } from 'vitest'
import {
  isAnalyticsEnabled,
  isErrorTrackingEnabled,
  isFlagsEnabled,
  isTimelineEnabled,
  posthogAppHost,
  posthogAssetsHost,
  posthogFlagUrl,
  timelineLinks,
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

describe('isTimelineEnabled', () => {
  it('is on only when both the personal key and the project id are set', () => {
    expect(
      isTimelineEnabled({
        POSTHOG_PERSONAL_API_KEY: 'phx_test_key_not_real',
        POSTHOG_PROJECT_ID: 1,
      })
    ).toBe(true)
    expect(
      isTimelineEnabled({
        POSTHOG_PERSONAL_API_KEY: 'phx_test_key_not_real',
        POSTHOG_PROJECT_ID: undefined,
      })
    ).toBe(false)
    expect(isTimelineEnabled({ POSTHOG_PERSONAL_API_KEY: undefined, POSTHOG_PROJECT_ID: 1 })).toBe(
      false
    )
  })

  it('is off under the test environment, which sets neither', () => {
    expect(isTimelineEnabled()).toBe(false)
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

// eslint-disable-next-line unicorn/no-null -- JSON null, as the page carries it for the other kind's link
const NO_LINK = null

describe('timelineLinks', () => {
  const env = {
    POSTHOG_HOST: 'https://eu.i.posthog.com',
    POSTHOG_APP_HOST: undefined,
    POSTHOG_PROJECT_ID: 4321,
  }

  it("links a user timeline to the person page and the project's replay template", () => {
    expect(timelineLinks({ kind: 'user', id: 'user-1' }, env)).toEqual({
      person: 'https://eu.posthog.com/project/4321/person/user-1',
      group: NO_LINK,
      replay: 'https://eu.posthog.com/project/4321/replay/{sessionId}',
    })
  })

  it('links a tenant timeline to the group page under the resolved group type index', () => {
    expect(timelineLinks({ kind: 'tenant', id: 'tenant-1', groupTypeIndex: 2 }, env)).toEqual({
      person: NO_LINK,
      group: 'https://eu.posthog.com/project/4321/groups/2/tenant-1',
      replay: 'https://eu.posthog.com/project/4321/replay/{sessionId}',
    })
  })

  it('URL-encodes the id and follows POSTHOG_APP_HOST', () => {
    const links = timelineLinks(
      { kind: 'user', id: 'a/b?c' },
      { ...env, POSTHOG_APP_HOST: 'https://posthog.example.test/' }
    )
    expect(links.person).toBe('https://posthog.example.test/project/4321/person/a%2Fb%3Fc')
  })

  it('throws without a project id', () => {
    expect(() =>
      timelineLinks({ kind: 'user', id: 'user-1' }, { ...env, POSTHOG_PROJECT_ID: undefined })
    ).toThrow('POSTHOG_PROJECT_ID is not set')
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
