// src/validators/auth.validators.ts
//
// Registration and login share an email schema but deliberately NOT a
// password schema. Registration's password goes through a real policy (a
// length floor as a weak-password guard, and a byte ceiling — see below).
// Login's does not: a login attempt with a too-short or too-long password
// must fail with the exact same "invalid credentials" response as a wrong
// password for a real account (auth.controller.ts's identical-error
// property), and routing it through a DIFFERENT validation error first
// would leak that distinction back to an unauthenticated caller before the
// controller ever gets a chance to make the two paths agree.
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
import { HttpError } from '@/middlewares/error.middleware'

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
 * Parse a request body against a schema, translating a failure into the
 * envelope's field-level `errors` (error.middleware.ts / HttpError) rather
 * than a caller having to know to look for a zod-shaped error some other
 * way.
 *
 * Surfaces both halves of zod's flattened error: `fieldErrors` (keyed by
 * field name — unchanged from before this comment was written; every
 * existing caller reads `errors.<field>` directly and that keeps working
 * exactly as it did) and, additively, `formErrors` under `errors.formErrors`
 * whenever there is at least one. `formErrors` holds issues that name no
 * single field — a `.strict()` schema's "unrecognized key" being the
 * motivating case. Before this, that case reached the client as `errors:
 * {}`: a 400 that looks like a validation bug rather than what actually
 * happened, because the one issue that existed had nowhere to attach and was
 * silently dropped. `.strict()` is unusable without this fix — its entire
 * rejection IS a formErrors issue — even though no schema in this codebase
 * currently uses `.strict()` (see profile.validators.ts for why the
 * alternative was chosen there; this fix is what makes `.strict()` a real
 * option for whoever needs it next).
 * @param schema - The schema to validate against.
 * @param input - The raw, untrusted request body.
 * @returns The parsed, typed input.
 * @throws {HttpError} 400, with `errors` set to one message array per invalid field, plus `errors.formErrors` for any schema-level issue that names no single field.
 */
export function parseBody<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const { fieldErrors, formErrors } = z.flattenError(result.error)
    throw new HttpError('Validation failed', 400, undefined, {
      ...fieldErrors,
      ...(formErrors.length > 0 && { formErrors }),
    })
  }
  return result.data
}
