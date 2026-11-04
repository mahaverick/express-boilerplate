/**
 * @file The body of `POST /api/v1/account/deletion-request`: an optional
 * reason, multi-line plain text of at most
 * `ACCOUNT_DELETION_REASON_MAX_LENGTH` characters after trimming.
 */
import { z } from 'zod'
import { ACCOUNT_DELETION_REASON_MAX_LENGTH } from '@/database/models/account-deletion-request.model'
import {
  normalizeMultilineText,
  safeText,
  unsafeTextMessage,
} from '@/validators/safe-text.validators'

/**
 * What a reason over the limit reads.
 */
const REASON_TOO_LONG_MESSAGE = `Reason must be at most ${String(ACCOUNT_DELETION_REASON_MAX_LENGTH)} characters.`

/**
 * A reason after `\r\n` becomes `\n`: trimmed, within the limit, and free of
 * control characters but line breaks and tabs, and of bidi overrides.
 */
const reasonText = z
  .string()
  .trim()
  .max(ACCOUNT_DELETION_REASON_MAX_LENGTH, REASON_TOO_LONG_MESSAGE)
  .refine(safeText({ multiline: true }), unsafeTextMessage('Reason', { multiline: true }))

/**
 * `POST /account/deletion-request` body. `reason` is optional; a blank one
 * reads as none.
 */
export const accountDeletionRequestBody = z.object({
  reason: z.preprocess(normalizeMultilineText, reasonText).optional(),
})
