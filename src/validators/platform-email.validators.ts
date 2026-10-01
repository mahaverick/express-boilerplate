/**
 * @file The staff email and suppression queries. `from`/`to` are UTC calendar
 * days; `to` is inclusive, so the service turns it into an exclusive end one
 * day later.
 */
import { z } from 'zod'
import { EMAIL_MESSAGE_STATUSES } from '@/constants/email.constants'
import { EMAIL_SUPPRESSION_STATE_FILTERS, STATS_RANGES } from '@/constants/platform.constants'
import { EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'
import { cursorField } from '@/validators/cursor.validators'
import { directionField, pageLimitField, searchQueryField } from '@/validators/platform.validators'

/**
 * A cursor's `sortAt`: `created_at` as UTC text with microseconds, exactly
 * as the repository selects it.
 */
const SORT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/**
 * The email and suppression cursors' decoded shape: the last row's
 * `created_at` (microsecond text) and id.
 */
export const emailCursorSchema = z.strictObject({
  sortAt: z.string().regex(SORT_AT_PATTERN),
  id: z.uuid(),
})

/**
 * Refuse `direction=prev` without a cursor: there is no "last page" to start from.
 * @param query - The parsed query.
 * @param query.direction - Which way to page.
 * @param query.cursor - The decoded cursor, if any.
 * @param context - Zod's refinement context.
 */
function requireCursorForPrevious(
  query: { direction: string; cursor?: unknown },
  context: z.RefinementCtx
): void {
  if (query.direction === 'prev' && query.cursor === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['cursor'],
      message: 'cursor is required when direction is prev.',
    })
  }
}

/**
 * `GET /api/v1/platform/emails` query string. `q` matches the recipient
 * (case-insensitive substring); `from` and `to` are `YYYY-MM-DD` UTC days,
 * both inclusive, and `from` may not be after `to`.
 */
export const platformEmailSearchSchema = z
  .object({
    q: searchQueryField.optional(),
    status: z.enum(EMAIL_MESSAGE_STATUSES).optional(),
    template: z.enum(EMAIL_TEMPLATE_KEYS).optional(),
    tenantId: z.uuid('tenantId must be a valid UUID.').optional(),
    userId: z.uuid('userId must be a valid UUID.').optional(),
    from: z.iso.date('from must be a YYYY-MM-DD date.').optional(),
    to: z.iso.date('to must be a YYYY-MM-DD date.').optional(),
    cursor: cursorField(emailCursorSchema).optional(),
    direction: directionField,
    limit: pageLimitField,
  })
  .superRefine((query, context) => {
    requireCursorForPrevious(query, context)
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from.' })
    }
  })

/**
 * The validated email search query, with the cursor already decoded.
 */
export type PlatformEmailSearchQuery = z.infer<typeof platformEmailSearchSchema>

/**
 * `GET /platform/emails/health` query: the window, 7 days unless asked otherwise.
 */
export const emailHealthQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('7d'),
})

/**
 * `GET /api/v1/platform/email-suppressions` query string. `state` defaults
 * to `active`, the suppressions blocking sends.
 */
export const platformSuppressionSearchSchema = z
  .object({
    q: searchQueryField.optional(),
    state: z.enum(EMAIL_SUPPRESSION_STATE_FILTERS).default('active'),
    cursor: cursorField(emailCursorSchema).optional(),
    direction: directionField,
    limit: pageLimitField,
  })
  .superRefine(requireCursorForPrevious)

/**
 * The validated suppression search query, with the cursor already decoded.
 */
export type PlatformSuppressionSearchQuery = z.infer<typeof platformSuppressionSearchSchema>
