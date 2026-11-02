/**
 * @file The text of every staff billing alert express raises. Apex shows
 * each one as sent, so each follows the copy rules: an active subject, an
 * amount in rupees, the provider ids staff look up in Razorpay, and a next
 * step where one exists. `tests/unit/copy-style.test.ts` renders every entry.
 *
 * Alerts are deduplicated by text (`BillingRepository.hasAlertNaming`), so a
 * change here may raise a reworded alert once more for a condition an older
 * alert already named. Keep each id early in its text, and keep
 * `cancelFailedMarker` (or `readFailedMarker`) inside every alert for a
 * cancel that left a subscription running, and `LIFECYCLE_ALERT_TEXT` inside every lifecycle
 * cancel alert: the scheduler searches for both.
 */
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { formatRupees } from '@/utilities/money-text.utilities'

/**
 * The text every alert about a lifecycle cancel that did not go through
 * holds, by which the frequent run finds the claims to retry. Alerts raised
 * before this wording hold it too.
 */
export const LIFECYCLE_ALERT_TEXT = 'of a suspended or archived workspace'

/**
 * The text every alert for a failed cancel of a subscription holds, which
 * the reconcile searches for to keep syncing a Free row whose subscription
 * may still charge.
 * @param subscriptionId - The subscription.
 * @returns The marker.
 */
export function cancelFailedMarker(subscriptionId: string): string {
  return `Cancelling subscription ${subscriptionId} failed`
}

/**
 * The text an alert holds when reading a subscription failed before its
 * cancel, so no cancel was tried. The reconcile searches for it as it does
 * `cancelFailedMarker`: the subscription still charges either way.
 * @param subscriptionId - The subscription.
 * @returns The marker.
 */
export function readFailedMarker(subscriptionId: string): string {
  // The trailing "of" keeps it from matching a longer id that starts with this one.
  return `Reading subscription ${subscriptionId} of`
}

/**
 * The marker alerts raised before this wording held, still searched so an
 * alert already on record keeps its Free row syncing.
 * @param subscriptionId - The subscription.
 * @returns The earlier marker.
 */
export function legacyCancelFailedMarker(subscriptionId: string): string {
  return `Could not cancel subscription ${subscriptionId}`
}

/**
 * The end of a partial-refund alert: the amounts Razorpay reported and what
 * staff refund, worded so an amount it did not report never reads as ₹0.
 * @param amountMinor - The amount paid, in paise; null when not reported.
 * @param refundedMinor - The amount refunded, in paise; null when not reported.
 * @returns The text after "is only partly refunded".
 */
function partlyRefundedTail(amountMinor: number | null, refundedMinor: number | null): string {
  const check = 'Refund the rest in Razorpay.'
  if (refundedMinor === null) {
    return amountMinor === null
      ? `, and Razorpay did not report how much. ${check}`
      : `, and Razorpay did not report how much of its ₹${formatRupees(amountMinor)} payment. ${check}`
  }
  if (amountMinor === null) {
    return `: ₹${formatRupees(refundedMinor)} refunded, and Razorpay did not report the amount paid. ${check}`
  }
  return `: ₹${formatRupees(refundedMinor)} of ₹${formatRupees(amountMinor)} refunded. Refund the remaining ₹${formatRupees(amountMinor - refundedMinor)} in Razorpay.`
}

/**
 * Each staff billing alert's text, by what happened.
 */
export const BILLING_ALERT_TEXT = {
  // The sync's provider read.
  foreignSubscription: (id: string) =>
    `The sync skipped subscription ${id} because its notes name another workspace. Check its notes in Razorpay.`,
  unknownPrice: (id: string) =>
    `The sync did not make subscription ${id} current because its notes name no known price. Check its notes in Razorpay.`,

  // The sync's follow-up cancels.
  cancelFailed: (id: string) => `${cancelFailedMarker(id)}. Cancel it in Razorpay.`,
  switchCancelFailed: (id: string) =>
    `${cancelFailedMarker(id)}. It was the cycle-end cancel for an interval switch, so both subscriptions charge until you cancel it at its cycle end in Razorpay.`,
  switchCancelNotRecorded: (id: string, cycleEnd: Date | null) =>
    `Razorpay will cancel subscription ${id} at its cycle end${cycleEnd === null ? '' : `, ${formatUtcDateTime(cycleEnd)},`} for an interval switch, but the workspace shows a renewal. Resync the workspace. If a cancel-failed alert for it follows, cancel it in Razorpay at that cycle end.`,

  // Refunding a duplicate subscription.
  duplicateCancelFailed: (id: string) =>
    `Cancelling duplicate subscription ${id} failed. Cancel and refund it in Razorpay.`,
  duplicateRefundFailed: (id: string) =>
    `We cancelled duplicate subscription ${id}, but its refund failed. Refund it in Razorpay.`,
  duplicateRefunded: (id: string, amountMinor: number, refundId: string) =>
    `We cancelled duplicate subscription ${id} and refunded ₹${formatRupees(amountMinor)} in refund ${refundId}. No action needed.`,
  duplicateNothingPaid: (id: string) =>
    `We cancelled duplicate subscription ${id}. It had no payment to refund, so no action is needed.`,
  duplicatePartlyRefunded: (id: string, amountMinor: number | null, refundedMinor: number | null) =>
    `Duplicate subscription ${id} is only partly refunded${partlyRefundedTail(amountMinor, refundedMinor)}`,

  // Refunding a subscription an archived workspace adopted.
  archivedCancelFailed: (id: string) =>
    `${cancelFailedMarker(id)}, and an archived workspace adopted it. Cancel and refund it in Razorpay.`,
  archivedRefundFailed: (id: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted, but its refund failed. Refund it in Razorpay.`,
  archivedRefunded: (id: string, amountMinor: number, refundId: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted, and refunded ₹${formatRupees(amountMinor)} in refund ${refundId}. No action needed.`,
  archivedNothingPaid: (id: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted. It had no payment to refund, so no action is needed.`,
  archivedPartlyRefunded: (id: string, amountMinor: number | null, refundedMinor: number | null) =>
    `Subscription ${id}, which an archived workspace adopted, is only partly refunded${partlyRefundedTail(amountMinor, refundedMinor)}`,

  // The state machine.
  subscriptionCompleted: (id: string) =>
    `Subscription ${id} billed its last cycle, so the workspace moved to Free. No action needed.`,
  lateSwitchRefunded: (nextId: string, currentId: string) =>
    `Interval switch ${nextId} was paid after subscription ${currentId} renewed, so we kept ${currentId} and are refunding ${nextId}. Its own alert reports the refund.`,
  activeWithoutPeriodEnd: (id: string) =>
    `The workspace is active on subscription ${id} with no paid period end. Check its invoices in Razorpay.`,

  // The scheduler.
  trialEndConflict: () =>
    'The trial ended, but its billing record changed during every sync attempt, so the workspace is not on Free. The billing scheduler retries it every 15 minutes.',
  trialEndSyncFailed: () =>
    'The trial ended, but syncing its subscriptions failed, so its billing record still reads trialing, though members already get Free limits. The billing scheduler retries it every 15 minutes. If this alert is still open after 1 hour, check Razorpay, then resync the workspace.',
  trialEndUnknownSubscription: () =>
    'The trial ended holding a subscription Razorpay does not know, so ending the trial ignores that subscription. Check its billing.',
  lifecycleCancelFailed: (id: string) =>
    `${cancelFailedMarker(id)}, so this subscription ${LIFECYCLE_ALERT_TEXT} still charges. Cancel it in Razorpay, at its cycle end if the workspace was paying.`,
  lifecycleReadFailed: (id: string) =>
    `Reading subscription ${id} ${LIFECYCLE_ALERT_TEXT} from Razorpay failed, so we did not cancel it, and it charges until it is cancelled. Cancel it in Razorpay, at its cycle end if the workspace was paying.`,
  lifecycleCheckoutReadFailed: (id: string) =>
    `Reading checkout ${id} ${LIFECYCLE_ALERT_TEXT} from Razorpay failed before its cancel. Check in Razorpay whether it was paid, and refund it if so.`,
  lifecycleCheckoutSyncFailed: () =>
    `Syncing a paid checkout ${LIFECYCLE_ALERT_TEXT} failed, so we cancelled nothing. Resync the workspace.`,
  reconcileListFailed: (day: string, lookbackDays: number) =>
    `Listing the subscriptions of the last ${String(lookbackDays)} days from Razorpay failed on ${day}, so the daily reconcile skipped them. Check Razorpay, then resync every workspace with a checkout in those ${String(lookbackDays)} days.`,

  // Webhooks.
  disputeStatusUnread: (paymentId: string) =>
    `Payment ${paymentId} has a new dispute, and reading its status from Razorpay failed. Respond in Razorpay before the respond-by date on the dispute.`,
  paidSubscriptionUnheld: (id: string) =>
    `Subscription ${id} is paid, but no workspace here holds it. Check its notes in Razorpay.`,
  disputeUnheld: (paymentId: string) =>
    `Payment ${paymentId} has an open dispute, and no workspace here holds its subscription. Respond in Razorpay before the respond-by date on the dispute.`,
  disputeOpen: (paymentId: string) =>
    `Payment ${paymentId} has an open dispute. Respond in Razorpay before the respond-by date on the dispute.`,
  webhookFailed: (eventId: string, eventType: string, attempts: number) =>
    `Razorpay event ${eventId} (${eventType}) failed on all ${String(attempts)} attempts, and its job stopped retrying. Resync the workspace.`,
  stillRetrying: (what: string) =>
    `${what} is still retrying after an hour of provider outage. It retries for 24 hours. Check Razorpay's status page.`,

  // Tax documents.
  taxHeldSez: (paymentId: string, amountMinor: number) =>
    `Payment ${paymentId} of ₹${formatRupees(amountMinor)} is held: this workspace is a Special Economic Zone (SEZ) unit. Issue its tax invoice by hand, then mark it resolved on the workspace's Billing tab.`,
  taxHeldSezRefunded: (paymentId: string, amountMinor: number, refundId: string) =>
    `Payment ${paymentId} of a held Special Economic Zone (SEZ) invoice was refunded ₹${formatRupees(amountMinor)} (refund ${refundId}). Issue a credit note by hand.`,
  taxIssueFailed: (tenantId: string, date: string) =>
    `Tax documents for workspace ${tenantId} were not issued on ${date}. Check the error log for this workspace, then resync it.`,
  taxRefundOverCredit: (
    refundId: string,
    amountMinor: number,
    remainingMinor: number,
    invoiceNumber: string
  ) =>
    `Refund ${refundId} of ₹${formatRupees(amountMinor)} is more than the ₹${formatRupees(remainingMinor)} left to credit on ${invoiceNumber}. No credit note was issued. Check this invoice's manual credit notes.`,
  taxInvoiceLate: (count: number, first: string, last: string) =>
    count === 1
      ? `1 tax invoice, ${first}, was issued more than 30 days after payment. Tell your chartered accountant (CA).`
      : `${count} tax invoices, ${first} to ${last}, were issued more than 30 days after payment. Tell your chartered accountant (CA).`,
  taxCreditNoteLate: (number: string, invoiceNumber: string, year: number) =>
    `Credit note ${number} for ${invoiceNumber} was issued after 30 November ${year}, so it gives no tax reduction. Tell your chartered accountant (CA).`,
} as const

/**
 * One kind of staff billing alert text.
 */
export type BillingAlertTextKey = keyof typeof BILLING_ALERT_TEXT
