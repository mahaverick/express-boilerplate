/**
 * @file Auth request bodies. Every string field is capped at the width of the
 * column it is written to (the `MAX_*_LENGTH` constants user.model.ts also
 * uses): an over-long value would otherwise reach Postgres as a 22001 and
 * answer 500 instead of 400. `password` is stored only as its fixed-width
 * bcrypt hash.
 */
import { z } from 'zod'
import {
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from '@/constants/auth.constants'
import { safeText } from '@/validators/safe-text.validators'

/**
 * Normalised email: trimmed, lowercased, max-length-capped, then piped
 * through `z.email()`. Normalising before the pipe matters: `z.email()`
 * checks the format before any transform chained after it, so it would
 * reject surrounding whitespace, and the cap would measure the untrimmed
 * value. The validated value is the one inserted, which keeps it agreeing
 * with the `lower(email)` unique index. The one email policy, shared by every
 * auth schema.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`)
  .pipe(z.email())

/**
 * The password policy for a password being set: a length floor, and
 * bcrypt's 72-byte ceiling, over which `hashPassword` throws a plain `Error`
 * that would answer 500.
 */
const registrationPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
    message: 'Password is too long.',
  })

/**
 * Registration request body: an email, a password meeting the registration
 * password policy, and optional display names.
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: registrationPasswordSchema,
  firstName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine(safeText(), 'First name contains characters that are not allowed')
    .optional(),
  lastName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine(safeText(), 'Last name contains characters that are not allowed')
    .optional(),
})

/**
 * The validated shape of a registration request body.
 */
export type RegisterInput = z.infer<typeof registerSchema>

/**
 * Login request body: an email and a password. The password carries no
 * policy: a too-short or too-long one must fail with the same 401 as a wrong
 * password, not a distinguishable 400 first.
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.'),
})

/**
 * The validated shape of a login request body.
 */
export type LoginInput = z.infer<typeof loginSchema>

/**
 * Forgot-password request body: just an email. Malformed or well-formed,
 * known or unknown, this schema never produces a distinguishable outcome —
 * `forgotPassword` (auth.controller.ts) answers the same 202 either way.
 */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
})

/**
 * The validated shape of a forgot-password request body.
 */
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>

/**
 * Reset-password request body: the raw token from the mailed link, and a new
 * password, which goes through `registrationPasswordSchema`.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required.'),
  password: registrationPasswordSchema,
})

/**
 * The validated shape of a reset-password request body.
 */
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

/**
 * Change-password request body: the caller's current password, and a new
 * one.
 *
 * `currentPassword` carries no policy, as with login: it is verified, not
 * set, so a policy would answer a wrong short password differently from a
 * wrong long one, and would reject a real password set under an older
 * policy. `newPassword` goes through `registrationPasswordSchema`.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: registrationPasswordSchema,
})

/**
 * The validated shape of a change-password request body.
 */
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
