/**
 * @file Auth request bodies. Email fields are capped at the width of the
 * column they are written to (`MAX_EMAIL_LENGTH`, which user.model.ts also
 * uses): an over-long value would otherwise reach Postgres as a 22001 and
 * answer 500 instead of 400.
 */
import { z } from 'zod'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import { FRONTEND_APPS } from '@/constants/frontend.constants'

/**
 * Normalised email: trimmed, lowercased, max-length-capped, then piped
 * through `z.email()`. Normalising before the pipe matters: `z.email()`
 * checks the format before any transform chained after it, so it would
 * reject surrounding whitespace, and the cap would measure the untrimmed
 * value. The validated value is the one inserted, which keeps it agreeing
 * with the `lower(email)` unique index. The one email policy: every schema
 * that takes an address builds on it.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`)
  .pipe(z.email())

/**
 * Which frontend a mailed link or OAuth redirect should open. An enum, never a
 * URL, so a request can only choose between the two configured origins.
 */
export const frontendAppSchema = z.enum(FRONTEND_APPS).default('web')

/**
 * Sign-out-of-other-sessions request body: empty. Strict, so an unknown key
 * is a 400 rather than silently ignored.
 */
export const revokeOtherSessionsSchema = z.strictObject({})
