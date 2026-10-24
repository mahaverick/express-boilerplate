/**
 * @file Request bodies and queries of a workspace owner's billing routes.
 */
import { z } from 'zod'
import { BILLING_INTERVALS } from '@/constants/billing.constants'
import { MAX_CURSOR_LENGTH } from '@/utilities/list-cursor.utilities'

/**
 * The longest provider id or signature a confirm may carry: Razorpay's ids
 * are under 20 characters and its signature is 64 hex characters.
 */
const CONFIRM_FIELD_MAX_LENGTH = 128

/**
 * `POST /billing/checkout` and `POST /billing/interval`: which interval to bill.
 */
export const billingIntervalBodySchema = z.strictObject({
  interval: z.enum(BILLING_INTERVALS, { error: 'Choose month or year.' }),
})

/**
 * `POST /billing/payment-method` and `POST /billing/cancel`: an empty body.
 */
export const emptyBillingBodySchema = z.strictObject({})

/**
 * One field the provider's checkout hands the browser.
 * @param label - The field's name in the message.
 * @returns The schema.
 */
function confirmField(label: string) {
  return z
    .string({ error: `Send the ${label} from the checkout.` })
    .min(1, `Send the ${label} from the checkout.`)
    .max(CONFIRM_FIELD_MAX_LENGTH, `The ${label} is too long. Send the one from the checkout.`)
}

/**
 * `POST /billing/checkout/confirm`: the three ids the provider's checkout
 * hands the browser after a payment. Other fields are dropped.
 */
export const checkoutConfirmBodySchema = z.object({
  razorpay_payment_id: confirmField('payment ID'),
  razorpay_subscription_id: confirmField('subscription ID'),
  razorpay_signature: confirmField('signature'),
})

/**
 * `GET /billing/invoices`: the previous page's cursor, if any.
 */
export const invoiceListQuerySchema = z.object({
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
})
