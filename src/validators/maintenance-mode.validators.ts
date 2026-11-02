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
import {
  normalizeMultilineText,
  safeText,
  unsafeTextMessage,
} from '@/validators/safe-text.validators'

/**
 * The longest `confirm` accepted: longer than any `APP_ENV` value.
 */
const CONFIRM_MAX_LENGTH = 32

/**
 * Multi-line plain text of 1 to `MAINTENANCE_MODE_TEXT_MAX_LENGTH`
 * characters after trimming (`\r\n` becomes `\n`); other control
 * characters and bidi overrides are refused.
 * @param field - The field's name, for the messages.
 */
function maintenanceText(field: string) {
  const unsafeText = unsafeTextMessage(`${field.charAt(0).toUpperCase()}${field.slice(1)}`, {
    multiline: true,
  })
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
      .refine(safeText({ multiline: true }), unsafeText)
  )
}

/**
 * `PUT /platform/maintenance-mode` body. `reason: null` clears the stored
 * reason on a save that keeps the mode; leaving it out keeps it. `confirm`
 * is the typed environment name. Strict, so no other field rides along.
 */
export const changeMaintenanceModeBody = z.strictObject({
  mode: z.enum(MAINTENANCE_MODES),
  message: maintenanceText('message').optional(),
  reason: maintenanceText('reason').nullable().optional(),
  expectedVersion: z
    .number({ error: 'Send the version you loaded, a whole number of 0 or more.' })
    .int('Send the version you loaded, a whole number of 0 or more.')
    .min(0, 'Send the version you loaded, a whole number of 0 or more.'),
  confirm: z.string().max(CONFIRM_MAX_LENGTH).optional(),
})

/**
 * A validated change body.
 */
export type ChangeMaintenanceModeBody = z.infer<typeof changeMaintenanceModeBody>
