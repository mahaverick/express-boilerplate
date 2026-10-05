/**
 * @file The server's calls to PostHog's private API (`/api/projects/…`) with
 * the personal API key: the timeline queries, the group types lookup, person
 * deletion and `pnpm flags:sync`'s flag list and creates. Each call is classified, never thrown, so a PostHog outage
 * reaches the caller as a value. The key travels only in the `Authorization`
 * header and is never logged or put in an error message. Redirects are
 * refused rather than followed: a redirected POST would lose its body.
 */
import { posthogAppHost } from '@/configs/analytics.config'
import { getEnv } from '@/configs/env.config'
import { TIMELINE_POSTHOG_TIMEOUT_MS } from '@/constants/timeline.constants'

/**
 * How one private-API call ended: `ok` for any 2xx (202 included), with the
 * parsed JSON body (undefined when the body is empty or not JSON);
 * `http_error` for any other status, carrying the parsed body only when the
 * caller asked for it (`shouldReadErrorBody`); `timeout` when the call
 * outlasted its timeout; `network` for every other failure to get an answer,
 * a refused redirect included.
 */
export type PosthogApiResult =
  | { kind: 'ok'; status: number; json: unknown }
  | { kind: 'http_error'; status: number; json?: unknown }
  | { kind: 'timeout' }
  | { kind: 'network' }

/**
 * The path of a project-scoped private-API endpoint.
 * @param suffix - The endpoint under the project, ending with `/` (e.g. `query/`): PostHog
 *   redirects a path without it, and a redirected POST loses its body.
 * @returns `/api/projects/<POSTHOG_PROJECT_ID>/<suffix>`.
 * @throws {Error} When `suffix` does not end with `/`, or `POSTHOG_PROJECT_ID` is not set.
 */
export function posthogProjectPath(suffix: string): string {
  if (!suffix.endsWith('/')) throw new Error('A PostHog API path must end with "/"')
  const projectId = getEnv().POSTHOG_PROJECT_ID
  if (projectId === undefined) throw new Error('POSTHOG_PROJECT_ID is not set')
  return `/api/projects/${String(projectId)}/${suffix}`
}

/**
 * Whether an error is `AbortSignal.timeout`'s.
 * @param error - What `fetch` or the body read threw.
 * @returns True for a `TimeoutError`.
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

/**
 * Parse a response body as JSON.
 * @param text - The body.
 * @returns The parsed value, or undefined when the body is empty or not JSON.
 */
function parsedJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Cancel a response body that will not be read, so the connection returns to
 * `fetch`'s pool.
 * @param response - The response.
 * @returns Resolves once cancelled; a body that cannot be cancelled changes nothing.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The status is already known.
  }
}

/**
 * Call PostHog's private API at `posthogAppHost()` with the personal API key.
 * @param method - `GET` or `POST`.
 * @param path - A path from `posthogProjectPath`.
 * @param body - A JSON body for a POST.
 * @param options - Call options.
 * @param options.timeoutMs - How long the whole call, body included, may take;
 *   defaults to `TIMELINE_POSTHOG_TIMEOUT_MS`.
 * @param options.query - Query parameters appended to `path`, URL-encoded.
 * @param options.shouldReadErrorBody - Whether an `http_error` carries its
 *   parsed body (a validation error's `code`, say); off, the body is discarded.
 * @returns How the call ended.
 * @throws {Error} When `POSTHOG_PERSONAL_API_KEY` is not set (only code that
 *   checked `isTimelineEnabled()` may call), or `path` does not end with `/`.
 */
export async function posthogApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: {
    timeoutMs?: number
    query?: Readonly<Record<string, string>>
    shouldReadErrorBody?: boolean
  } = {}
): Promise<PosthogApiResult> {
  const env = getEnv()
  const apiKey = env.POSTHOG_PERSONAL_API_KEY
  if (apiKey === undefined) throw new Error('POSTHOG_PERSONAL_API_KEY is not set')
  if (!path.endsWith('/')) throw new Error('A PostHog API path must end with "/"')
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const search =
    options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`
  try {
    const response = await fetch(`${posthogAppHost(env)}${path}${search}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMELINE_POSTHOG_TIMEOUT_MS),
    })
    if (response.status < 200 || response.status >= 300) {
      if (options.shouldReadErrorBody === true) {
        return {
          kind: 'http_error',
          status: response.status,
          json: parsedJson(await response.text()),
        }
      }
      await discardBody(response)
      return { kind: 'http_error', status: response.status }
    }
    return { kind: 'ok', status: response.status, json: parsedJson(await response.text()) }
  } catch (error) {
    return { kind: isTimeoutError(error) ? 'timeout' : 'network' }
  }
}
