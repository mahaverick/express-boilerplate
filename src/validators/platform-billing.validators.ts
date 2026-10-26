/**
 * @file Request bodies of the staff billing routes: one tenant's trial
 * extension, grant and staff cancel; a plan's preview and edit; a new
 * price; the billing settings edit; the alerts list query; and one tenant's
 * history, events, subscriptions and invoices list queries. Every write
 * carries the staff member's reason (`reasonSchema`). A grant or a plan
 * names registry keys and values of each key's kind, so a typo or a wrong
 * kind is a field error, never a stored value that grants nothing. A grant
 * and a plan share one cap on a limit.
 */
import { z } from 'zod'
import {
  BILLING_EVENT_STATUSES,
  BILLING_HISTORY_SOURCES,
  BILLING_INTERVALS,
  BILLING_PROVIDER_MODES,
  BILLING_PROVIDERS,
  INVOICE_STATUSES,
  MAX_TRIAL_DAYS,
  STAFF_CANCEL_WHEN,
} from '@/constants/billing.constants'
import {
  ENTITLEMENTS,
  type EntitlementDefinition,
  type EntitlementValue,
} from '@/constants/entitlements.constants'
import { MAX_CURSOR_LENGTH } from '@/utilities/list-cursor.utilities'
import { listFilter, listParamsSchema } from '@/validators/list.validators'
import { reasonSchema } from '@/validators/platform.validators'
import { safeText } from '@/validators/safe-text.validators'

/**
 * The largest limit a grant or a plan may set; null is no cap at all.
 */
const MAX_GRANT_LIMIT = 1_000_000

/**
 * `MAX_GRANT_LIMIT` as people read it.
 */
const MAX_GRANT_LIMIT_TEXT = '1,000,000'

/**
 * Whether a value is one a limit may hold: a whole number from 1 to
 * `MAX_GRANT_LIMIT`, or null for no cap.
 * @param value - The value sent.
 * @returns True when a limit may take it.
 */
function isLimitValue(value: unknown): boolean {
  if (value === null) return true
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_GRANT_LIMIT
  )
}

/**
 * `POST /tenants/:id/billing/extend-trial`: how many days to add, and why.
 */
export const extendTrialBodySchema = z.strictObject({
  days: z
    .number({ error: `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.` })
    .int(`Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`)
    .min(1, `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`)
    .max(MAX_TRIAL_DAYS, `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`),
  reason: reasonSchema,
})

/**
 * `POST /tenants/:id/billing/grants`: the entitlement, its value, when it
 * lapses (null for never), and why. A limit takes a whole number of at least
 * 1 up to `MAX_GRANT_LIMIT`, or null for no cap; a feature takes `true`,
 * since a grant only ever adds access. The expiry must be in the future.
 * Every field's error is reported at once.
 */
export const grantBodySchema = z
  .strictObject({
    key: z.string({ error: 'Choose a limit or feature this product has.' }),
    value: z.union([z.boolean(), z.number(), z.null()], {
      error: 'Enter a number for a limit, or true for a feature.',
    }),
    expiresAt: z.iso
      .datetime({ error: 'Choose an end date, or leave Ends on empty for no end date.' })
      .nullable(),
    reason: reasonSchema,
  })
  .superRefine((body, context) => {
    if (!Object.hasOwn(ENTITLEMENTS, body.key)) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: 'Choose a limit or feature this product has.',
      })
    }
    const definition = Object.hasOwn(ENTITLEMENTS, body.key)
      ? (ENTITLEMENTS[body.key as keyof typeof ENTITLEMENTS] as EntitlementDefinition)
      : undefined
    if (definition?.kind === 'feature' && body.value !== true) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message:
          'A feature grant only turns the feature on. To set a number, choose a limit instead.',
      })
    }
    if (definition?.kind === 'limit' && !isLimitValue(body.value)) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Enter a whole number from 1 to ${MAX_GRANT_LIMIT_TEXT}, or choose No limit.`,
      })
    }
    if (body.expiresAt !== null && new Date(body.expiresAt).getTime() <= Date.now()) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Choose today or a later date, or leave it empty for no end date.',
      })
    }
  })

/**
 * A validated grant body.
 */
export type GrantBody = z.infer<typeof grantBodySchema>

/**
 * `POST /tenants/:id/billing/cancel`: when the subscription ends, and why.
 */
export const staffCancelBodySchema = z.strictObject({
  when: z.enum(STAFF_CANCEL_WHEN, { error: 'Choose when the subscription ends.' }),
  reason: reasonSchema,
})

/**
 * A plan's entitlements as staff send them: any of the registry's keys, each
 * with a value of its kind. A limit takes what a grant takes; a feature
 * takes `true` or `false`, since a plan may leave a feature out. Every bad
 * key is reported, one message each, and an empty object is refused: it
 * would change nothing.
 */
const planEntitlementsSchema = z
  .record(z.string(), z.unknown(), { error: 'Send entitlements as an object of keys and values.' })
  .superRefine((entitlements, context) => {
    const known = Object.keys(ENTITLEMENTS).join(', ')
    if (Object.keys(entitlements).length === 0) {
      context.addIssue({
        code: 'custom',
        message: `Send at least one entitlement to change. This product has: ${known}.`,
      })
    }
    for (const [key, value] of Object.entries(entitlements)) {
      if (!Object.hasOwn(ENTITLEMENTS, key)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `Remove the keys this product doesn't have. It has: ${known}.`,
        })
        continue
      }
      const definition: EntitlementDefinition = ENTITLEMENTS[key as keyof typeof ENTITLEMENTS]
      if (definition.kind === 'feature' && typeof value !== 'boolean') {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${definition.label}: choose whether the plan includes this feature.`,
        })
      }
      if (definition.kind === 'limit' && !isLimitValue(value)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${definition.label}: enter a whole number from 1 to ${MAX_GRANT_LIMIT_TEXT}, or choose No limit.`,
        })
      }
    }
  })
  .transform((entitlements) => entitlements as Record<string, EntitlementValue>)

/**
 * `POST /plans/:id/preview`: the entitlements an edit would send.
 */
export const planPreviewBodySchema = z.strictObject({ entitlements: planEntitlementsSchema })

/**
 * The longest plan name, the column's width.
 */
const MAX_PLAN_NAME_LENGTH = 64

/**
 * The longest plan description, the column's width.
 */
const MAX_PLAN_DESCRIPTION_LENGTH = 280

/**
 * A stored row's `version`, as the client read it.
 */
const versionSchema = z
  .number({ error: 'Send the version you loaded, a whole number.' })
  .int('Send the version you loaded, a whole number.')
  .min(1, 'Send the version you loaded, a whole number.')

/**
 * `PATCH /plans/:id`: the version the client read, at least one of name,
 * description and entitlements, and why. The entitlements sent replace those
 * keys' values; keys not sent keep theirs. An empty description clears it.
 */
export const updatePlanBodySchema = z
  .strictObject({
    version: versionSchema,
    name: z
      .string({ error: 'Enter a plan name.' })
      .trim()
      .min(1, 'Enter a plan name.')
      .max(
        MAX_PLAN_NAME_LENGTH,
        `Keep the plan name to ${String(MAX_PLAN_NAME_LENGTH)} characters.`
      )
      .refine(safeText(), 'Remove the control characters from the plan name.')
      .optional(),
    description: z
      .string({ error: 'Enter the description as text.' })
      .trim()
      .max(
        MAX_PLAN_DESCRIPTION_LENGTH,
        `Keep the description to ${String(MAX_PLAN_DESCRIPTION_LENGTH)} characters.`
      )
      .refine(safeText(), 'Remove the control characters from the description.')
      .optional(),
    entitlements: planEntitlementsSchema.optional(),
    reason: reasonSchema,
  })
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.entitlements !== undefined,
    { message: 'Change the name, the description or an entitlement.' }
  )

/**
 * A validated plan edit.
 */
export type UpdatePlanBody = z.infer<typeof updatePlanBodySchema>

/**
 * The lowest price staff may set, in paise: ₹1.
 */
const MIN_PRICE_MINOR = 100

/**
 * The highest price staff may set, in paise: ₹1,00,000.
 */
const MAX_PRICE_MINOR = 10_000_000

/**
 * What a price outside the range reads: in whole rupees, as staff enter it
 * in apex, though the body carries paise.
 */
const PRICE_RANGE_MESSAGE = 'Enter a whole number of rupees from ₹1 to ₹1,00,000.'

/**
 * `POST /plans/:id/prices`: the interval, the amount in paise, tax
 * included, and why.
 */
export const createPriceBodySchema = z.strictObject({
  interval: z.enum(BILLING_INTERVALS, { error: 'Choose month or year.' }),
  amountMinor: z
    .number({ error: PRICE_RANGE_MESSAGE })
    .int(PRICE_RANGE_MESSAGE)
    .min(MIN_PRICE_MINOR, PRICE_RANGE_MESSAGE)
    .max(MAX_PRICE_MINOR, PRICE_RANGE_MESSAGE),
  reason: reasonSchema,
})

/**
 * A validated new price.
 */
export type CreatePriceBody = z.infer<typeof createPriceBodySchema>

/**
 * The longest grace staff may give a halted or paused subscription, in
 * days. The `billing_settings` CHECK holds the same range.
 */
const MAX_PAST_DUE_GRACE_DAYS = 30

/**
 * `PATCH /billing-settings`: the version the client read, at least one
 * setting, and why. The trial length runs 1 to `MAX_TRIAL_DAYS` days and the
 * grace 1 to `MAX_PAST_DUE_GRACE_DAYS`, the ranges the table's CHECKs hold.
 */
export const updateBillingSettingsBodySchema = z
  .strictObject({
    version: versionSchema,
    trialEnabled: z
      .boolean({ error: 'Choose whether new workspaces get a Paid trial.' })
      .optional(),
    trialDays: z
      .number({ error: `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.` })
      .int(`Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`)
      .min(1, `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`)
      .max(MAX_TRIAL_DAYS, `Enter a whole number of days from 1 to ${String(MAX_TRIAL_DAYS)}.`)
      .optional(),
    pastDueGraceDays: z
      .number({
        error: `Enter a whole number of days from 1 to ${String(MAX_PAST_DUE_GRACE_DAYS)}.`,
      })
      .int(`Enter a whole number of days from 1 to ${String(MAX_PAST_DUE_GRACE_DAYS)}.`)
      .min(1, `Enter a whole number of days from 1 to ${String(MAX_PAST_DUE_GRACE_DAYS)}.`)
      .max(
        MAX_PAST_DUE_GRACE_DAYS,
        `Enter a whole number of days from 1 to ${String(MAX_PAST_DUE_GRACE_DAYS)}.`
      )
      .optional(),
    reason: reasonSchema,
  })
  .refine(
    (body) =>
      body.trialEnabled !== undefined ||
      body.trialDays !== undefined ||
      body.pastDueGraceDays !== undefined,
    { message: 'Change at least one setting: trials, the trial length or the grace period.' }
  )

/**
 * A validated billing settings edit.
 */
export type UpdateBillingSettingsBody = z.infer<typeof updateBillingSettingsBodySchema>

/**
 * `GET /platform/billing/alerts` query: the shared list params, newest
 * first unless asked otherwise; `search` matches the message.
 */
export const billingAlertListSchema = listParamsSchema({
  sorts: ['-at', 'at'],
  defaultSort: '-at',
  filters: {},
})

/**
 * A parsed alerts list query.
 */
export type BillingAlertListQuery = z.output<typeof billingAlertListSchema>

/**
 * `GET /platform/tenants/:id/billing/history` query: the shared list
 * params, newest first unless asked otherwise; `search` matches the from
 * and to states and the cause; `source` is a comma list.
 */
export const billingHistoryListSchema = listParamsSchema({
  sorts: ['-at', 'at'],
  defaultSort: '-at',
  filters: { source: listFilter('source', BILLING_HISTORY_SOURCES).optional() },
})

/**
 * A parsed history list query.
 */
export type BillingHistoryListQuery = z.output<typeof billingHistoryListSchema>

/**
 * `GET /platform/tenants/:id/billing/events` query: the shared list params,
 * newest received first unless asked otherwise; `search` matches the type
 * and the error; `status` is a comma list.
 */
export const billingEventListSchema = listParamsSchema({
  sorts: ['-at', 'at'],
  defaultSort: '-at',
  filters: { status: listFilter('status', BILLING_EVENT_STATUSES).optional() },
})

/**
 * A parsed events list query.
 */
export type BillingEventListQuery = z.output<typeof billingEventListSchema>

/**
 * `GET /platform/tenants/:id/billing/subscriptions` query: the shared list
 * params, newest first seen unless asked otherwise; `search` matches the
 * subscription id; `provider` and `mode` are comma lists.
 */
export const billingSubscriptionListSchema = listParamsSchema({
  sorts: ['-firstSeen', 'firstSeen'],
  defaultSort: '-firstSeen',
  filters: {
    provider: listFilter('provider', BILLING_PROVIDERS).optional(),
    mode: listFilter('mode', BILLING_PROVIDER_MODES).optional(),
  },
})

/**
 * A parsed subscriptions list query.
 */
export type BillingSubscriptionListQuery = z.output<typeof billingSubscriptionListSchema>

/**
 * `GET /platform/tenants/:id/billing/invoices` query: the previous page's
 * cursor and a comma list of statuses. The provider pages forward only,
 * newest first, 20 invoices a page, so the list takes no sort, search,
 * direction, limit or total.
 */
export const staffInvoiceListSchema = z.object({
  // Capped as the owner list's; verifyCursor refuses any other bad one as InvalidCursorError.
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  status: listFilter('status', INVOICE_STATUSES).optional(),
})

/**
 * A parsed staff invoice list query.
 */
export type StaffInvoiceListQuery = z.output<typeof staffInvoiceListSchema>
