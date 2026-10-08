/**
 * @file The one call to PostHog's `GET /flags/definitions`, with the feature
 * flags secure key. The answer is untrusted input: redirects are refused,
 * the whole call is bounded by `FLAG_DEFINITIONS_TIMEOUT_MS`, and the body is
 * read as a stream and abandoned past `FLAG_DEFINITIONS_MAX_BYTES`. Every
 * outcome is a value, never a throw, and neither key is ever logged or put
 * in a result.
 */
import { getEnv } from '@/configs/env.config'
import {
  FLAG_DEFINITIONS_MAX_BYTES,
  FLAG_DEFINITIONS_TIMEOUT_MS,
} from '@/constants/flags.constants'
import { logger } from '@/services/logger.service'
import type { FlagFetchErrorCode } from '@/types/flags'

/**
 * How one fetch ended: the parsed body and the ETag header (null when
 * absent), a 304, a failure code (with the status for an HTTP error), or
 * `aborted` when the caller's own signal ended it before PostHog answered.
 */
export type FlagDefinitionsResult =
  | { kind: 'ok'; body: unknown; etag: string | null }
  | { kind: 'not_modified' }
  | { kind: 'error'; code: FlagFetchErrorCode; status?: number }
  | { kind: 'aborted' }

const RATE_LIMIT_WARNING_HEADER = 'x-posthog-rate-limit-warning'
const LOGGED_HEADER_MAX = 200

/**
 * Whether an error is an abort by a timeout signal.
 * @param error - What `fetch` or the body read threw.
 * @returns True for a `TimeoutError`.
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

/**
 * Read a body as a stream, giving up past `max` bytes.
 * @param response - The response.
 * @param max - The most bytes kept.
 * @returns The bytes, or undefined when the body is larger than `max`.
 */
async function readCapped(response: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > max) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  const read = { bytes: 0 }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    read.bytes += value.byteLength
    if (read.bytes > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Parse a body as JSON.
 * @param bytes - The body.
 * @returns The value, or undefined when it is not JSON.
 */
function parsedJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Classify a response that arrived.
 * @param response - The response.
 * @returns The result.
 */
async function resultOf(response: Response): Promise<FlagDefinitionsResult> {
  const warning = response.headers.get(RATE_LIMIT_WARNING_HEADER)
  if (warning !== null) {
    logger.warn('PostHog warned that flag definition fetches are near its rate limit', {
      warning: warning.slice(0, LOGGED_HEADER_MAX),
    })
  }
  if (response.status === 304) {
    await response.body?.cancel()
    return { kind: 'not_modified' }
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel()
    const code = response.status === 401 || response.status === 403 ? 'unauthorized' : 'http_error'
    return { kind: 'error', code, status: response.status }
  }
  const bytes = await readCapped(response, FLAG_DEFINITIONS_MAX_BYTES)
  if (bytes === undefined) return { kind: 'error', code: 'body_too_large' }
  const body = parsedJson(bytes)
  if (body === undefined) return { kind: 'error', code: 'invalid_body' }
  // eslint-disable-next-line unicorn/no-null -- the result's contract is null for no ETag
  return { kind: 'ok', body, etag: response.headers.get('etag') ?? null }
}

/**
 * Fetch the project's flag definitions: `GET <POSTHOG_HOST>/flags/definitions?token=<project key>`
 * with `Authorization: Bearer <feature flags key>` and, when given,
 * `If-None-Match` set to the stored ETag exactly as PostHog sent it (a weak
 * `W/"…"` tag).
 * @param etag - The stored ETag, or null for an unconditional fetch.
 * @param options - Call options.
 * @param options.signal - Aborts the call early; `FLAG_DEFINITIONS_TIMEOUT_MS` applies either way.
 * @returns How the fetch ended.
 * @throws {Error} When `POSTHOG_FEATURE_FLAGS_KEY` or `POSTHOG_PROJECT_KEY` is
 *   not set: only code that checked `isFlagsEnabled()` may call.
 */
export async function fetchFlagDefinitions(
  etag: string | null,
  options: { signal?: AbortSignal } = {}
): Promise<FlagDefinitionsResult> {
  const env = getEnv()
  const secureKey = env.POSTHOG_FEATURE_FLAGS_KEY
  const projectKey = env.POSTHOG_PROJECT_KEY
  if (secureKey === undefined || projectKey === undefined) {
    throw new Error('Feature flags are not configured')
  }
  const url = new URL('/flags/definitions', env.POSTHOG_HOST)
  url.searchParams.set('token', projectKey)
  const headers: Record<string, string> = {
    authorization: `Bearer ${secureKey}`,
    accept: 'application/json',
  }
  if (etag !== null) headers['if-none-match'] = etag
  const timeout = AbortSignal.timeout(FLAG_DEFINITIONS_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal })
    return await resultOf(response)
  } catch (error) {
    if (isTimeoutError(error)) return { kind: 'error', code: 'timeout' }
    // The caller gave up (a shutdown, say): not PostHog's failure, so not recorded as one.
    if (options.signal?.aborted === true) return { kind: 'aborted' }
    return { kind: 'error', code: 'network' }
  }
}
