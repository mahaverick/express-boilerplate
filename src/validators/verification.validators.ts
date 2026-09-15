// src/validators/verification.validators.ts
//
// The verify body carries a PASSWORD as well as a token, and it is not
// optional — see the spec's squatting section. Neither field carries the
// registration password policy: this is a comparison against a stored
// hash, exactly like login, and applying a policy here would answer
// differently for a password that was legal when it was set and is not
// now. auth.validators.ts makes the same call for loginSchema.
import { z } from 'zod'
import { emailSchema } from '@/validators/auth.validators'

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
export const resendVerificationSchema = z.object({ email: emailSchema })

/**
 * The validated shape of a resend-verification request body.
 */
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>
