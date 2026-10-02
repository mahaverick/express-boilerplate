/**
 * @file The mass-assignment boundary for `PATCH /api/v1/profile`: an explicit
 * allow-list of the fields a caller may set.
 */
import { z } from 'zod'
import { MAX_NAME_LENGTH } from '@/constants/auth.constants'
import { safeText } from '@/validators/safe-text.validators'

/**
 * A name field with PATCH's three states: absent leaves the column unchanged
 * (`toUpdateValues` checks presence with `Object.hasOwn`), `null` clears it,
 * and a string (trimmed) sets it. Absent and `null` stay distinct, so "clear
 * my last name" differs from "leave it alone".
 */
const optionalNameField = z
  .string()
  .trim()
  .min(1, 'Must not be empty.')
  .max(MAX_NAME_LENGTH, `Must be at most ${MAX_NAME_LENGTH} characters.`)
  .refine(safeText(), 'This field contains characters that are not allowed')
  .nullable()
  .optional()

/**
 * `PATCH /api/v1/profile` request body: the only fields this endpoint lets a
 * caller change, the two names and the browser analytics opt-out.
 *
 * Not strict: an unrecognised key (`email`, `id`, `passwordHash`, `active`)
 * is stripped, not rejected, so a client that PATCHes back the whole object
 * it fetched still succeeds. `email` is excluded because it is a verified
 * identity; changing it here would leave `emailVerifiedAt` attached to an
 * address nobody has verified.
 */
export const updateProfileSchema = z.object({
  firstName: optionalNameField,
  lastName: optionalNameField,
  analyticsOptOut: z.boolean().optional(),
})

/**
 * The validated shape of a `PATCH /api/v1/profile` request body.
 */
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
