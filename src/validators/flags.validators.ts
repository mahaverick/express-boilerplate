/**
 * @file The body of the three `…/flags/exposures` routes, and the allowlist
 * each reported key must pass: registered, read by the client, an
 * experiment, and served to the app the route belongs to. Any other key gets
 * one fixed message that never names it, so the answer can't tell an
 * unregistered key from a non-experiment one.
 */
import { z } from 'zod'
import { clientFlagsFor, FLAG_KEY_MAX, type MultivariateFlagKey } from '@/constants/flags.constants'
import { HttpError } from '@/errors/http-error'
import type { FlagApp } from '@/types/flags'
import { parseBody } from '@/validators/parse.validators'

/**
 * The most keys one exposure report may carry.
 */
export const MAX_EXPOSURE_KEYS = 10

/**
 * The message every key outside the allowlist gets.
 */
export const EXPOSURE_KEY_MESSAGE = 'keys must name experiment flags this app reads.'

/**
 * `{ keys }`: 1 to `MAX_EXPOSURE_KEYS` distinct strings of at most
 * `FLAG_KEY_MAX` characters, nothing else. The
 * object is strict, so a client can't send a value: the server evaluates
 * every key itself.
 */
export const exposureBodySchema = z.strictObject({
  keys: z
    .array(z.string().max(FLAG_KEY_MAX))
    .min(1)
    .max(MAX_EXPOSURE_KEYS)
    .refine((keys) => new Set(keys).size === keys.length, { message: 'keys must be unique.' }),
})

/**
 * Parse an exposure body and check every key against the app's experiment
 * flags.
 * @param body - The raw request body.
 * @param app - The app whose exposure route was called.
 * @returns The keys, each a multivariate experiment flag of `app`.
 * @throws {HttpError} 400 `Validation failed` when the body is malformed or a key is outside the allowlist.
 */
export function parseExposureKeys(body: unknown, app: FlagApp): MultivariateFlagKey[] {
  const { keys } = parseBody(exposureBodySchema, body)
  const allowed = new Set(
    clientFlagsFor(app)
      .filter((entry) => entry.experiment && entry.kind === 'multivariate')
      .map((entry) => entry.key)
  )
  if (keys.some((key) => !allowed.has(key))) {
    throw new HttpError('Validation failed', 400, undefined, { keys: [EXPOSURE_KEY_MESSAGE] })
  }
  // Every key is a registered multivariate entry's key, checked just above.
  return keys as MultivariateFlagKey[]
}
