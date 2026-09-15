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
import { z } from 'zod'
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '@/constants/auth.constants'
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
const emailSchema = z.string().trim().toLowerCase().pipe(z.email())

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
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
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
