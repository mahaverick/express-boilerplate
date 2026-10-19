/**
 * @file The bodies of the staff step-up routes: `POST /auth/step-up/link/request`
 * and `/step-up/google/start` take none, and `/step-up/link/verify` takes the
 * link's token.
 */
import { z } from 'zod'

/**
 * A body-less step-up request or Google start: empty. Strict, so an unknown
 * key is a 400 rather than silently ignored.
 */
export const stepUpEmptyBodySchema = z.strictObject({})

/**
 * A step-up link confirm: the raw token from the link. Any string is
 * accepted, so a malformed token gets the same `LINK_INVALID` as an unknown
 * one; only a missing or non-string token fails validation.
 */
export const stepUpLinkVerifySchema = z.object({
  token: z.string(),
})
