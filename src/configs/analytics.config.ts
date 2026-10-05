/**
 * @file Whether analytics and the staff timelines are on, where PostHog's
 * assets and app live, and the PostHog deep links staff open, as pure
 * functions of the validated environment. Without `POSTHOG_PROJECT_KEY`
 * analytics is inert: no outbox row is written, the drainer never starts and
 * the collect proxy answers 503. Without `POSTHOG_PERSONAL_API_KEY` and
 * `POSTHOG_PROJECT_ID` the timelines answer "not configured". Error tracking
 * also needs `ERROR_TRACKING_ENABLED`.
 */
import { getEnv, type Env } from '@/configs/env.config'

const EU_ASSETS_HOST = 'https://eu-assets.i.posthog.com'
const US_ASSETS_HOST = 'https://us-assets.i.posthog.com'
const EU_APP_HOST = 'https://eu.posthog.com'
const US_APP_HOST = 'https://us.posthog.com'

/**
 * The placeholder Apex replaces with a session id in `links.replay`.
 */
export const REPLAY_SESSION_PLACEHOLDER = '{sessionId}'

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
 * Whether this environment can read PostHog for the staff timelines and
 * delete PostHog persons. Independent of `isAnalyticsEnabled`.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns True when both the personal API key and the project id are configured.
 */
export function isTimelineEnabled(
  env: Pick<Env, 'POSTHOG_PERSONAL_API_KEY' | 'POSTHOG_PROJECT_ID'> = getEnv()
): boolean {
  return env.POSTHOG_PERSONAL_API_KEY !== undefined && env.POSTHOG_PROJECT_ID !== undefined
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
 * Whose PostHog page a timeline links to: a user's person page, or a
 * tenant's group page under the `tenant` group type's index.
 */
export type TimelineLinkTarget =
  { kind: 'user'; id: string } | { kind: 'tenant'; id: string; groupTypeIndex: number }

/**
 * The PostHog deep links a timeline page carries.
 */
export interface TimelineLinks {
  /**
   * The user's person page; null on a tenant timeline.
   */
  person: string | null
  /**
   * The tenant's group page; null on a user timeline.
   */
  group: string | null
  /**
   * A replay URL with `REPLAY_SESSION_PLACEHOLDER` where the session id goes.
   */
  replay: string
}

/**
 * The deep links for one timeline, under `{app}/project/{pid}`: the person
 * page `person/{userId}`, the group page `groups/{index}/{tenantId}`, and
 * the replay template `replay/{sessionId}`. Ids are URL-encoded.
 * @param target - The user, or the tenant and its group type index.
 * @param env - The PostHog slice of the validated environment; defaults to `getEnv()`.
 * @returns The links.
 * @throws {Error} When `POSTHOG_PROJECT_ID` is not set: only code that checked
 *   `isTimelineEnabled()` may build links.
 */
export function timelineLinks(
  target: TimelineLinkTarget,
  env: Pick<Env, 'POSTHOG_HOST' | 'POSTHOG_APP_HOST' | 'POSTHOG_PROJECT_ID'> = getEnv()
): TimelineLinks {
  if (env.POSTHOG_PROJECT_ID === undefined) throw new Error('POSTHOG_PROJECT_ID is not set')
  const project = `${posthogAppHost(env)}/project/${String(env.POSTHOG_PROJECT_ID)}`
  const id = encodeURIComponent(target.id)
  return {
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for the other kind's link
    person: target.kind === 'user' ? `${project}/person/${id}` : null,
    group:
      target.kind === 'tenant'
        ? `${project}/groups/${String(target.groupTypeIndex)}/${id}`
        : // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for the other kind's link
          null,
    replay: `${project}/replay/${REPLAY_SESSION_PLACEHOLDER}`,
  }
}
