// src/validators/auth.validators.ts
//
// Registration and login share an email schema but deliberately NOT a
// password schema. Registration's password goes through a real policy (a
// length floor as a weak-password guard, and a byte ceiling — see below).
// Login's does not: a login attempt with a too-short or too-long password
// must fail with the exact same "invalid credentials" response as a wrong
// password for a real account (auth.service.ts's identical-error
// property), and routing it through a DIFFERENT validation error first
// would leak that distinction back to an unauthenticated caller before
// login ever gets a chance to make the two paths agree.
//
// The byte ceiling on registration matters for a reason that has nothing to
// do with password strength: `hashPassword` (password.utilities.ts) throws
// a bare `Error` — not `HttpError` — for input over bcrypt's 72-byte limit.
// Rejecting that here, as an ordinary validation failure, is what stands
// between a too-long password and an unhandled 500.
//
// The LENGTH CEILINGS below exist for the same class of reason, one step
// further down: every string field this file accepts is bounded by exactly
// the width of the column it is written to (MAX_EMAIL_LENGTH /
// MAX_NAME_LENGTH, auth.constants.ts — the same constants user.model.ts
// declares those columns with, so the two cannot drift). A schema that
// accepts more than its column holds does not merely fail: it fails as a
// 500. Postgres rejects an over-long value with 22001, which is not the
// unique violation `BaseRepository.create` translates to a 409, so it
// propagates as an unexpected error — a client error answered as a server
// error. A 400-character address did exactly that before this cap.
//
// Audited against the schema at the time of writing, as one pass rather
// than field by field: `email` -> users.email (320, capped here);
// `firstName`/`lastName` -> users.first_name/last_name (100, capped here
// and in profile.validators.ts). `password` is never stored as given —
// only its 60-character bcrypt hash is, a width bcrypt fixes, not input —
// and every remaining column on either table is server-generated (ids,
// token hashes, timestamps) and reachable from no request body at all.
import { z } from 'zod'
import {
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from '@/constants/auth.constants'

// z.email() validates the email FORMAT before any transform chained after
// it runs — verified empirically: z.email().trim().toLowerCase() still
// rejects a leading/trailing-whitespace address, because the format check
// happens first and only the (still-untrimmed) result is transformed
// afterwards. Chaining .trim()/.toLowerCase() on a plain z.string() BEFORE
// piping into z.email() runs normalisation in the order that actually
// matters: trim and lowercase, THEN validate. This is also what keeps a
// registered row's stored email agreeing with the table's `lower(email)`
// unique index (user.model.ts) — the value validated here is the value the
// controller inserts, not a copy normalised separately at the call site.
// `.max()` sits BEFORE the pipe, so it measures the trimmed, lowercased
// value — the exact string the controller goes on to insert — rather than
// whatever whitespace the client happened to send around it. A too-long
// address therefore fails validation here (400) instead of the column
// (22001 -> 500); see this file's header comment.
/**
 * Normalised email: trimmed, lowercased, max-length-capped, then piped
 * through `z.email()` for format validation. Shared between registration,
 * login, and verification schemas — a single definition of the email policy
 * so two copies cannot drift.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`)
  .pipe(z.email())

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
  firstName: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  lastName: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
})

/**
 * The validated shape of a registration request body.
 */
export type RegisterInput = z.infer<typeof registerSchema>

/**
 * Login request body: an email and a password. See this file's header
 * comment for why the password field carries no policy of its own.
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
 * password. The password goes through the SAME `registrationPasswordSchema`
 * registration uses — not a fresh `z.string().min(8)` — for the exact reason
 * this file's header comment gives for that schema existing at all: without
 * the byte-ceiling refine, a password past bcrypt's 72-byte limit would reach
 * `hashPassword` (password.utilities.ts) and throw a bare `Error`, answering
 * a client-error case as a 500.
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
 * `currentPassword` carries NO policy — the identical reasoning this file's
 * header comment gives for `loginSchema`'s password, applied to an
 * authenticated caller instead of an anonymous one: a policy here would
 * leak nothing useful (the caller already knows what they typed) and would
 * answer a wrong-but-well-formed current password differently from a
 * wrong-and-short one — a distinguishable 400 BEFORE the controller ever
 * compares it against the stored hash, rather than the identical
 * "incorrect" outcome both cases must produce. It would also incorrectly
 * reject a caller's real, current password if that password predates
 * today's policy (this schema's `newPassword` floor did not always exist),
 * which `currentPassword` must never do — it is being verified, not set.
 *
 * `newPassword` goes through the SAME `registrationPasswordSchema`
 * registration and reset-password use — not a fresh policy — for the exact
 * reason this file's header comment gives for that schema existing at all.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: registrationPasswordSchema,
})

/**
 * The validated shape of a change-password request body.
 */
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
