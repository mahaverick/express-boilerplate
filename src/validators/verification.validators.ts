/**
 * @file Verify-email and resend-verification bodies. Verify requires the
 * account's password as well as the token, so a link holder cannot verify an
 * address someone else registered. Neither applies the registration password
 * policy: like login, this compares against a stored hash, and a policy would
 * answer differently for a password that was legal when it was set.
 */
import { z } from 'zod'
import { emailSchema, frontendAppSchema } from '@/validators/auth.validators'

/**
 * Verify-email request body: the raw token from the link, plus the
 * account's password.
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required.'),
  password: z.string().min(1, 'Password is required.'),
})

/**
 * The validated shape of a verify-email request body.
 */
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>

/**
 * Resend-verification request body: an address, which may or may not exist.
 */
export const resendVerificationSchema = z.object({ email: emailSchema, app: frontendAppSchema })

/**
 * The validated shape of a resend-verification request body.
 */
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>
