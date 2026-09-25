// src/validators/parse.validators.ts
//
// Moved verbatim from auth.validators.ts — a generic zod-parsing helper
// belongs beside every other validator schema, not inside the one file
// that first needed it.
import { z } from 'zod'
import { HttpError } from '@/errors/http-error'

/**
 * Parse a request body against a schema, translating a failure into the
 * envelope's field-level `errors` (errors/http-error.ts / HttpError) rather
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
