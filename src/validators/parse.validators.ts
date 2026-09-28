/**
 * @file `parseBody`, the generic zod parse that turns a failure into the
 * envelope's field-level `errors`.
 */
import { z } from 'zod'
import { HttpError } from '@/errors/http-error'

/**
 * Parse request input (a body, query or params) against a schema,
 * translating a failure into the envelope's field-level `errors`.
 *
 * Surfaces both halves of zod's flattened error: `fieldErrors`, keyed by
 * field name, and `formErrors` under `errors.formErrors` when there is at
 * least one. `formErrors` holds issues that name no single field, such as a
 * strict schema's unrecognized key; without it that 400 would reach the
 * client as `errors: {}`.
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
