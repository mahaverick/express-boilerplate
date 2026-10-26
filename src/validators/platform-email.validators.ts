/**
 * @file The staff email and suppression queries. `from`/`to` are UTC calendar
 * days; `to` is inclusive, so the service turns it into an exclusive end one
 * day later.
 */
import { z } from 'zod'
import { EMAIL_MESSAGE_STATUSES } from '@/constants/email.constants'
import { STATS_RANGES } from '@/constants/platform.constants'
import {
  EMAIL_TEMPLATE_KEYS,
  RETIRED_EMAIL_TEMPLATE_KEYS,
} from '@/utilities/email-template.utilities'
import { listFilter, listParamsSchema } from '@/validators/list.validators'

/**
 * A `YYYY-MM-DD` UTC day in years 0001-9998: Postgres has no year 0, and the
 * service turns an inclusive `to` into an exclusive end one day later, which
 * must still be a four-digit year.
 * @param name - The query field's name, for its messages.
 */
function utcDayField(name: string) {
  return z.iso
    .date(`${name} must be a YYYY-MM-DD date.`)
    .refine(
      (day) => day >= '0001-01-01' && day <= '9998-12-31',
      `${name} must be between 0001-01-01 and 9998-12-31.`
    )
}

/**
 * `GET /api/v1/platform/emails` query: the shared list params, `search`
 * matching the recipient; `status` and `template` comma lists, `template`
 * taking a retired key too, so old messages stay findable; `user` and
 * `tenant` ids; `from` and `to` UTC days, both inclusive, `from` not after `to`.
 */
export const platformEmailListSchema = listParamsSchema({
  sorts: ['-created', 'created'],
  defaultSort: '-created',
  filters: {
    status: listFilter('status', EMAIL_MESSAGE_STATUSES).optional(),
    template: listFilter('template', [
      ...EMAIL_TEMPLATE_KEYS,
      ...RETIRED_EMAIL_TEMPLATE_KEYS,
    ]).optional(),
    user: z.uuid('user must be a 36-character user ID.').optional(),
    tenant: z.uuid('tenant must be a 36-character tenant ID.').optional(),
    from: utcDayField('from').optional(),
    to: utcDayField('to').optional(),
  },
  refine: (filters, context) => {
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Choose an end date on or after the start date.',
      })
    }
  },
})

/**
 * A parsed staff email list query.
 */
export type PlatformEmailListQuery = z.output<typeof platformEmailListSchema>

/**
 * `GET /platform/emails/health` query: the window, 7 days unless asked otherwise.
 */
export const emailHealthQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('7d'),
})

/**
 * The suppression states a list may ask for.
 */
const SUPPRESSION_STATES = ['active', 'lifted'] as const

/**
 * `GET /api/v1/platform/email-suppressions` query: the shared list params,
 * `search` matching the address; `state` a comma list, active (blocking
 * sends) unless given.
 */
export const platformSuppressionListSchema = listParamsSchema({
  sorts: ['-created', 'created', 'address'],
  defaultSort: '-created',
  filters: { state: listFilter('state', SUPPRESSION_STATES).default(['active']) },
})

/**
 * A parsed staff suppression list query.
 */
export type PlatformSuppressionListQuery = z.output<typeof platformSuppressionListSchema>
