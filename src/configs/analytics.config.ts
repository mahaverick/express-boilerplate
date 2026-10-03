/**
 * @file Whether analytics is on, and where PostHog's assets live, as pure
 * functions of the validated environment. Without `POSTHOG_PROJECT_KEY`
 * analytics is inert: no outbox row is written, the drainer never starts and
 * the collect proxy answers 503.
 */
import { getEnv, type Env } from '@/configs/env.config'

const EU_ASSETS_HOST = 'https://eu-assets.i.posthog.com'
const US_ASSETS_HOST = 'https://us-assets.i.posthog.com'

/**
 * Whether this environment reports to PostHog.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns True when a project key is configured.
 */
export function isAnalyticsEnabled(env: Pick<Env, 'POSTHOG_PROJECT_KEY'> = getEnv()): boolean {
  return env.POSTHOG_PROJECT_KEY !== undefined
}

/**
 * The PostHog assets host: `POSTHOG_ASSETS_HOST` when set, otherwise the EU
 * assets host for an ingest host whose name starts with `eu.`, and the US one
 * for any other.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns The assets origin, with no trailing slash.
 */
export function posthogAssetsHost(
  env: Pick<Env, 'POSTHOG_HOST' | 'POSTHOG_ASSETS_HOST'> = getEnv()
): string {
  const override = env.POSTHOG_ASSETS_HOST
  if (override !== undefined) return override.endsWith('/') ? override.slice(0, -1) : override
  return new URL(env.POSTHOG_HOST).hostname.startsWith('eu.') ? EU_ASSETS_HOST : US_ASSETS_HOST
}
