/**
 * @file The body of `PUT /api/v1/platform/maintenance-mode`. Which fields a
 * change needs depends on the stored mode, so the service checks those
 * rules after reading it; this schema checks shapes and bounds only.
 */
import { z } from 'zod'
import {
  MAINTENANCE_MODE_TEXT_MAX_LENGTH,
  MAINTENANCE_MODES,
} from '@/constants/maintenance-mode.constants'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'

/**
 * The longest `confirm` accepted: longer than any `APP_ENV` value.
 */
const CONFIRM_MAX_LENGTH = 32

/**
 * Multi-line plain text of 1 to `MAINTENANCE_MODE_TEXT_MAX_LENGTH`
 * characters after trimming (`\r\n` becomes `\n`); other control
 * characters and bidi overrides are refused.
 * @param field - The field's name, for the messages.
 * @returns The schema.
 */
function maintenanceText(field: string) {
  return z.preprocess(
    normalizeMultilineText,
    z
      .string()
      .trim()
      .min(1, `${field} must not be empty.`)
      .max(
        MAINTENANCE_MODE_TEXT_MAX_LENGTH,
        `${field} must be at most ${String(MAINTENANCE_MODE_TEXT_MAX_LENGTH)} characters.`
      )
      .refine(safeText({ multiline: true }), `${field} contains characters that are not allowed.`)
  )
}

/**
 * `PUT /platform/maintenance-mode`: the new mode, the customer message,
 * the internal reason (`null` clears a stored one on a save that keeps the
 * mode; absent keeps it), the version the caller read, and the typed
 * environment name. Strict, so no other field rides along.
 */
export const changeMaintenanceModeBody = z.strictObject({
  mode: z.enum(MAINTENANCE_MODES),
  message: maintenanceText('message').optional(),
  reason: maintenanceText('reason').nullable().optional(),
  expectedVersion: z.number().int().min(0),
  confirm: z.string().max(CONFIRM_MAX_LENGTH).optional(),
})

/**
 * A validated change body.
 */
export type ChangeMaintenanceModeBody = z.infer<typeof changeMaintenanceModeBody>
