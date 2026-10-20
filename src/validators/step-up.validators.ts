/**
 * @file The bodies of the step-up routes: `POST /auth/step-up/link/request`
 * names the frontend the link opens, `/step-up/link/verify` takes the link's
 * token, and the passkey step-up routes take a challenge id and the browser's
 * assertion.
 */
import { z } from 'zod'
import { FRONTEND_APPS } from '@/constants/frontend.constants'

/**
 * A step-up link request: the frontend the emailed link opens. Required, with
 * no default, since the link must open the app the person is in. Strict, so an
 * unknown key is a 400 rather than silently ignored.
 */
export const stepUpLinkRequestSchema = z.strictObject({ app: z.enum(FRONTEND_APPS) })

/**
 * A step-up link confirm: the raw token from the link. Any string is
 * accepted, so a malformed token gets the same `LINK_INVALID` as an unknown
 * one; only a missing or non-string token fails validation.
 */
export const stepUpLinkVerifySchema = z.object({
  token: z.string(),
})
