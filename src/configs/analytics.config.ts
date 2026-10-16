/**
 * @file Whether analytics, error tracking and feature flags are on, where
 * PostHog's assets and app live, and the PostHog deep links staff open, as
 * pure functions of the validated environment. Without
 * `POSTHOG_PROJECT_KEY` analytics is inert: no outbox row is written, no
 * drain runs and the collect proxy answers 503. PostHog's private API is
 * called only when both `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`
 * are set. Error tracking also needs `ERROR_TRACKING_ENABLED`. Feature flags
 * need `POSTHOG_FEATURE_FLAGS_KEY` and the project key; with either missing,
 * every flag answers its registry fallback.
 */
import { getEnv, type Env } from '@/configs/env.config'

const EU_ASSETS_HOST = 'https://eu-assets.i.posthog.com'
const US_ASSETS_HOST = 'https://us-assets.i.posthog.com'
const EU_APP_HOST = 'https://eu.posthog.com'
const US_APP_HOST = 'https://us.posthog.com'

/**
 * Whether this environment reports to PostHog.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns True when a project key is configured.
 */
export function isAnalyticsEnabled(env: Pick<Env, 'POSTHOG_PROJECT_KEY'> = getEnv()): boolean {
  return env.POSTHOG_PROJECT_KEY !== undefined
}

/**
 * Whether this process sends unexpected server errors to PostHog Error Tracking.
 * @param env - The PostHog and error-tracking slice of the validated environment; defaults to `getEnv()`.
 * @returns True when a project key is configured and `ERROR_TRACKING_ENABLED` is true.
 */
export function isErrorTrackingEnabled(
  env: Pick<Env, 'POSTHOG_PROJECT_KEY' | 'ERROR_TRACKING_ENABLED'> = getEnv()
): boolean {
  return isAnalyticsEnabled(env) && env.ERROR_TRACKING_ENABLED
}

/**
 * Whether this environment can call PostHog's private API (the personal key and
 * project id are both set): person deletions and `pnpm flags:sync` need it.
 * Independent of `isAnalyticsEnabled`.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns True when both the personal API key and the project id are configured.
 */
export function isPosthogApiEnabled(
  env: Pick<Env, 'POSTHOG_PERSONAL_API_KEY' | 'POSTHOG_PROJECT_ID'> = getEnv()
): boolean {
  return env.POSTHOG_PERSONAL_API_KEY !== undefined && env.POSTHOG_PROJECT_ID !== undefined
}

/**
 * Whether this environment fetches feature flag definitions and evaluates
 * flags from them. Off, every flag answers its registry fallback.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns True when both the project key and the feature flags secure key are configured.
 */
export function isFlagsEnabled(
  env: Pick<Env, 'POSTHOG_PROJECT_KEY' | 'POSTHOG_FEATURE_FLAGS_KEY'> = getEnv()
): boolean {
  return env.POSTHOG_PROJECT_KEY !== undefined && env.POSTHOG_FEATURE_FLAGS_KEY !== undefined
}

/**
 * An origin without its trailing slash.
 * @param origin - A validated URL.
 * @returns The same URL with at most one trailing slash removed.
 */
function withoutTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/**
 * Whether the ingest host is in PostHog's EU region: its hostname starts with `eu.`.
 * @param env - The PostHog slice of the validated environment.
 * @returns True for an EU ingest host.
 */
function isEuIngestHost(env: Pick<Env, 'POSTHOG_HOST'>): boolean {
  return new URL(env.POSTHOG_HOST).hostname.startsWith('eu.')
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
  if (override !== undefined) return withoutTrailingSlash(override)
  return isEuIngestHost(env) ? EU_ASSETS_HOST : US_ASSETS_HOST
}

/**
 * The PostHog app and private API origin: `POSTHOG_APP_HOST` when set,
 * otherwise `https://eu.posthog.com` for an ingest host whose name starts
 * with `eu.`, and `https://us.posthog.com` for any other.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns The app origin, with no trailing slash.
 */
export function posthogAppHost(
  env: Pick<Env, 'POSTHOG_HOST' | 'POSTHOG_APP_HOST'> = getEnv()
): string {
  const override = env.POSTHOG_APP_HOST
  if (override !== undefined) return withoutTrailingSlash(override)
  return isEuIngestHost(env) ? EU_APP_HOST : US_APP_HOST
}

/**
 * A feature flag's page in PostHog, `{app}/project/{pid}/feature_flags/{id}`.
 * @param flagId - PostHog's numeric id of the flag, from the definitions
 *   snapshot; 0 for a malformed definition that carried none.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns The URL, or null when `POSTHOG_PROJECT_ID` is not set or the id is not a positive safe integer.
 */
export function posthogFlagUrl(
  flagId: number,
  env: Pick<Env, 'POSTHOG_HOST' | 'POSTHOG_APP_HOST' | 'POSTHOG_PROJECT_ID'> = getEnv()
): string | null {
  const isFlagId = Number.isSafeInteger(flagId) && flagId >= 1
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null when no link can be built
  if (!isFlagId || env.POSTHOG_PROJECT_ID === undefined) return null
  return `${posthogAppHost(env)}/project/${String(env.POSTHOG_PROJECT_ID)}/feature_flags/${String(flagId)}`
}
