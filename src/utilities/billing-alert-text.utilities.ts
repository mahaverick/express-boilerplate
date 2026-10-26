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
  return `Reading subscription ${subscriptionId}`
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
  switchCancelNotRecorded: (id: string) =>
    `Razorpay will cancel subscription ${id} at its cycle end for an interval switch, but the workspace does not record it, so its billing shows a renewal. Resync the workspace to record it.`,

  // Refunding a duplicate subscription.
  duplicateCancelFailed: (id: string) =>
    `Cancelling duplicate subscription ${id} failed. Cancel and refund it in Razorpay.`,
  duplicateRefundFailed: (id: string) =>
    `We cancelled duplicate subscription ${id}, but its refund failed. Refund it in Razorpay.`,
  duplicateRefunded: (id: string, amountMinor: number, refundId: string) =>
    `We cancelled duplicate subscription ${id} and refunded ₹${formatRupees(amountMinor)} in refund ${refundId}. No action needed.`,
  duplicateNothingPaid: (id: string) =>
    `We cancelled duplicate subscription ${id}. It had no payment to refund, so no action is needed.`,
  duplicatePartlyRefunded: (id: string) =>
    `Duplicate subscription ${id} is only partly refunded. Refund the rest in Razorpay.`,

  // Refunding a subscription an archived workspace adopted.
  archivedCancelFailed: (id: string) =>
    `${cancelFailedMarker(id)}, and an archived workspace adopted it. Cancel and refund it in Razorpay.`,
  archivedRefundFailed: (id: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted, but its refund failed. Refund it in Razorpay.`,
  archivedRefunded: (id: string, amountMinor: number, refundId: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted, and refunded ₹${formatRupees(amountMinor)} in refund ${refundId}. No action needed.`,
  archivedNothingPaid: (id: string) =>
    `We cancelled subscription ${id}, which an archived workspace adopted. It had no payment to refund, so no action is needed.`,
  archivedPartlyRefunded: (id: string) =>
    `Subscription ${id}, which an archived workspace adopted, is only partly refunded. Refund the rest in Razorpay.`,

  // The state machine.
  subscriptionCompleted: (id: string) =>
    `Subscription ${id} billed its last cycle, so the workspace moved to Free. No action needed.`,
  lateSwitchRefunded: (nextId: string, currentId: string) =>
    `Interval switch ${nextId} was paid after subscription ${currentId} renewed, so we kept ${currentId} and are refunding ${nextId}. Its own alert reports the refund.`,
  activeWithoutPeriodEnd: (id: string) =>
    `The workspace is active on subscription ${id} with no paid period end. Check its invoices in Razorpay.`,

  // The scheduler.
  trialEndConflict: () =>
    'The trial ended, but its billing record changed during every sync attempt, so the workspace is not on Free. The next scheduler run retries it.',
  trialEndSyncFailed: () =>
    'The trial ended, but syncing its subscriptions failed, so the workspace is still on its trial. The next scheduler run retries it. If this repeats, check Razorpay, then resync the workspace.',
  trialEndUnknownSubscription: () =>
    'The trial ended holding a subscription Razorpay does not know, so ending the trial ignores that subscription. Check its billing.',
  lifecycleCancelFailed: (id: string) =>
    `${cancelFailedMarker(id)}, so this subscription ${LIFECYCLE_ALERT_TEXT} still charges. Cancel it in Razorpay.`,
  lifecycleReadFailed: (id: string) =>
    `${readFailedMarker(id)} ${LIFECYCLE_ALERT_TEXT} from Razorpay failed, so we did not cancel it and it still charges. Cancel it in Razorpay.`,
  lifecycleCheckoutReadFailed: (id: string) =>
    `Reading checkout ${id} ${LIFECYCLE_ALERT_TEXT} from Razorpay failed before its cancel. Check in Razorpay whether it was paid, and refund it if so.`,
  lifecycleCheckoutSyncFailed: () =>
    `Syncing a paid checkout ${LIFECYCLE_ALERT_TEXT} failed, so we cancelled nothing. Resync the workspace.`,
  reconcileListFailed: (day: string) =>
    `Listing recent subscriptions from Razorpay failed on ${day}, so the reconcile skipped them. Check Razorpay, then resync workspaces with a recent checkout.`,

  // Webhooks.
  disputeStatusUnread: (paymentId: string) =>
    `Payment ${paymentId} has a new dispute, and reading its status from Razorpay failed. Respond in Razorpay before its deadline.`,
  paidSubscriptionUnheld: (id: string) =>
    `Subscription ${id} is paid, but no workspace here holds it. Check its notes in Razorpay.`,
  disputeUnheld: (paymentId: string) =>
    `Payment ${paymentId} has an open dispute, and no workspace here holds its subscription. Respond in Razorpay before its deadline.`,
  disputeOpen: (paymentId: string) =>
    `Payment ${paymentId} has an open dispute. Respond in Razorpay before its deadline.`,
  webhookFailed: (eventId: string, eventType: string) =>
    `Razorpay event ${eventId} (${eventType}) failed after every retry. Resync the workspace.`,
  stillRetrying: (what: string) =>
    `${what} is still retrying after an hour of provider outage. It retries for 24 hours. Check Razorpay's status page.`,
} as const

/**
 * One kind of staff billing alert text.
 */
export type BillingAlertTextKey = keyof typeof BILLING_ALERT_TEXT
