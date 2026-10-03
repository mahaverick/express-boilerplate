/**
 * @file isAnalyticsEnabled and posthogAssetsHost, which are pure functions of
 * the environment slice they are given.
 */
import { describe, expect, it } from 'vitest'
import { isAnalyticsEnabled, posthogAssetsHost } from '@/configs/analytics.config'

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
