/**
 * @file Request bodies of the staff billing routes of one tenant: the trial
 * extension, a grant, and the staff cancel. Every write carries the staff
 * member's reason (`reasonSchema`). A grant names a registry key and a value
 * of that key's kind, so a typo or a wrong kind is a field error, never a
 * stored grant that grants nothing.
 */
import { z } from 'zod'
import { MAX_TRIAL_DAYS, STAFF_CANCEL_WHEN } from '@/constants/billing.constants'
import { ENTITLEMENTS, type EntitlementDefinition } from '@/constants/entitlements.constants'
import { reasonSchema } from '@/validators/platform.validators'

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
 * 1, or null for no cap; a feature takes `true`, since a grant only ever
 * adds access. The expiry must be in the future.
 */
export const grantBodySchema = z
  .strictObject({
    key: z.string({ error: 'Choose a limit or feature this product has.' }),
    value: z.union([z.boolean(), z.number(), z.null()], {
      error: 'Enter a number for a limit, or true for a feature.',
    }),
    expiresAt: z.iso
      .datetime({ error: 'Enter the expiry as an ISO date and time, or null for none.' })
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
      return
    }
    const definition = ENTITLEMENTS[body.key as keyof typeof ENTITLEMENTS] as EntitlementDefinition
    if (definition.kind === 'feature' && body.value !== true) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'A feature grant turns the feature on. Send true.',
      })
    }
    if (
      definition.kind === 'limit' &&
      body.value !== null &&
      (typeof body.value !== 'number' || !Number.isInteger(body.value) || body.value < 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a whole number of at least 1 for a limit, or null for no cap.',
      })
    }
    if (body.expiresAt !== null && new Date(body.expiresAt).getTime() <= Date.now()) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Choose an expiry in the future, or null for none.',
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
  when: z.enum(STAFF_CANCEL_WHEN, { error: 'Choose cycle_end or now.' }),
  reason: reasonSchema,
})
