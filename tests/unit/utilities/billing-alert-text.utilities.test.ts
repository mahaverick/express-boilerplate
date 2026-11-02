import { describe, expect, it } from 'vite-plus/test'
import {
  BILLING_ALERT_TEXT,
  cancelFailedMarker,
  LIFECYCLE_ALERT_TEXT,
  readFailedMarker,
} from '@/utilities/billing-alert-text.utilities'

describe('BILLING_ALERT_TEXT', () => {
  it('words a refund in rupees and keeps the provider ids', () => {
    expect(BILLING_ALERT_TEXT.duplicateRefunded('sub_FAKE1', 99_900, 'rfnd_FAKE1')).toBe(
      'We cancelled duplicate subscription sub_FAKE1 and refunded ₹999 in refund rfnd_FAKE1. No action needed.'
    )
    expect(BILLING_ALERT_TEXT.archivedRefunded('sub_FAKE1', 14_999_950, 'rfnd_FAKE1')).toBe(
      'We cancelled subscription sub_FAKE1, which an archived workspace adopted, and refunded ₹1,49,999.50 in refund rfnd_FAKE1. No action needed.'
    )
  })

  it('keeps the failed-cancel marker in every alert for a cancel that left a subscription running', () => {
    const marker = cancelFailedMarker('sub_X')
    for (const text of [
      BILLING_ALERT_TEXT.cancelFailed('sub_X'),
      BILLING_ALERT_TEXT.switchCancelFailed('sub_X'),
      BILLING_ALERT_TEXT.archivedCancelFailed('sub_X'),
      BILLING_ALERT_TEXT.lifecycleCancelFailed('sub_X'),
    ]) {
      expect(text).toContain(marker)
    }
    expect(BILLING_ALERT_TEXT.lifecycleReadFailed('sub_X')).toContain(readFailedMarker('sub_X'))
    // A longer id that starts with this one never matches its marker.
    expect(BILLING_ALERT_TEXT.lifecycleReadFailed('sub_X1')).not.toContain(
      readFailedMarker('sub_X')
    )
    expect(BILLING_ALERT_TEXT.cancelFailed('sub_X1')).not.toContain(marker)
    expect(BILLING_ALERT_TEXT.lifecycleReadFailed('sub_X')).not.toContain(marker)
    // A duplicate never became the workspace's current subscription, so the reconcile ignores it.
    expect(BILLING_ALERT_TEXT.duplicateCancelFailed('sub_X')).not.toContain(marker)
  })

  it('keeps the lifecycle text in every lifecycle cancel alert, which the retry searches for', () => {
    for (const text of [
      BILLING_ALERT_TEXT.lifecycleCancelFailed('sub_X'),
      BILLING_ALERT_TEXT.lifecycleReadFailed('sub_X'),
      BILLING_ALERT_TEXT.lifecycleCheckoutReadFailed('sub_X'),
      BILLING_ALERT_TEXT.lifecycleCheckoutSyncFailed(),
    ]) {
      expect(text).toContain(LIFECYCLE_ALERT_TEXT)
    }
  })

  it('keeps the text a webhook alert is deduplicated by', () => {
    expect(BILLING_ALERT_TEXT.webhookFailed('evt_1', 'subscription.charged', 31)).toContain(
      'evt_1 (subscription.charged) failed'
    )
    expect(
      BILLING_ALERT_TEXT.stillRetrying('Razorpay event evt_1 (subscription.charged)')
    ).toContain('evt_1 (subscription.charged) is still retrying')
  })

  it('states the real attempt count, the retry interval and the lookback', () => {
    expect(BILLING_ALERT_TEXT.webhookFailed('evt_1', 'payment.failed', 8)).toBe(
      'Razorpay event evt_1 (payment.failed) failed on all 8 attempts, and its job stopped retrying. Resync the workspace.'
    )
    expect(BILLING_ALERT_TEXT.trialEndSyncFailed()).toContain(
      'The billing scheduler retries it every 15 minutes. If this alert is still open after 1 hour,'
    )
    expect(BILLING_ALERT_TEXT.reconcileListFailed('2026-10-27', 3)).toContain(
      'Listing the subscriptions of the last 3 days from Razorpay failed on 2026-10-27'
    )
    expect(BILLING_ALERT_TEXT.lifecycleReadFailed('sub_X')).not.toMatch(/\bmay\b/)
  })

  it('names the cycle end of a switch cancel it did not record, when it is known', () => {
    const at = new Date('2026-11-07T10:30:00.000Z')
    expect(BILLING_ALERT_TEXT.switchCancelNotRecorded('sub_X', at)).toContain(
      'Razorpay will cancel subscription sub_X at its cycle end, 10:30 UTC on 7 November 2026, for an interval switch, but the workspace shows a renewal.'
    )
    expect(BILLING_ALERT_TEXT.switchCancelNotRecorded('sub_X', null)).toContain(
      'Razorpay will cancel subscription sub_X at its cycle end for an interval switch, but'
    )
  })

  it('fits every reworded alert, with real-length ids, in the 280 characters an alert stores', () => {
    // Razorpay ids are a prefix and 14 characters.
    const sub = 'sub_ABCDEFGHIJKLMN'
    const pay = 'pay_ABCDEFGHIJKLMN'
    const texts = [
      BILLING_ALERT_TEXT.switchCancelNotRecorded(sub, new Date('2026-11-07T10:30:00.000Z')),
      BILLING_ALERT_TEXT.lifecycleReadFailed(sub),
      BILLING_ALERT_TEXT.trialEndSyncFailed(),
      BILLING_ALERT_TEXT.reconcileListFailed('2026-10-27', 3),
      BILLING_ALERT_TEXT.disputeUnheld(pay),
      BILLING_ALERT_TEXT.webhookFailed('evt_ABCDEFGHIJKLMN', 'subscription.authenticated', 31),
      BILLING_ALERT_TEXT.taxHeldSez(pay, 14_999_950),
      BILLING_ALERT_TEXT.taxHeldSezRefunded(pay, 14_999_950, 'rfnd_ABCDEFGHIJKLMN'),
    ]
    for (const text of texts) expect(text.length, text).toBeLessThanOrEqual(280)
  })

  it('words the tax alerts as the API contract gives them', () => {
    expect(BILLING_ALERT_TEXT.taxHeldSez('pay_P1', 99_900)).toBe(
      "Payment pay_P1 of ₹999 is held: this workspace is a Special Economic Zone (SEZ) unit. Issue its tax invoice by hand, then mark it resolved on the workspace's Billing tab."
    )
    expect(BILLING_ALERT_TEXT.taxHeldSezRefunded('pay_P1', 99_900, 'rfnd_R1')).toBe(
      'Payment pay_P1 of a held Special Economic Zone (SEZ) invoice was refunded ₹999 (refund rfnd_R1). Issue a credit note by hand.'
    )
    expect(BILLING_ALERT_TEXT.taxIssueFailed('tenant-1', '2026-10-27')).toBe(
      'Tax documents for workspace tenant-1 were not issued on 2026-10-27. Check the error log for this workspace, then resync it.'
    )
    expect(
      BILLING_ALERT_TEXT.taxRefundOverCredit('rfnd_R1', 50_000, 20_000, 'INV/26-27/00001')
    ).toBe(
      "Refund rfnd_R1 of ₹500 is more than the ₹200 left to credit on INV/26-27/00001. No credit note was issued. Check this invoice's manual credit notes."
    )
    expect(BILLING_ALERT_TEXT.taxInvoiceLate(3, 'INV/26-27/00001', 'INV/26-27/00003')).toBe(
      '3 tax invoices, INV/26-27/00001 to INV/26-27/00003, were issued more than 30 days after payment. Tell your chartered accountant (CA).'
    )
    expect(BILLING_ALERT_TEXT.taxInvoiceLate(1, 'INV/26-27/00007', 'INV/26-27/00007')).toBe(
      '1 tax invoice, INV/26-27/00007, was issued more than 30 days after payment. Tell your chartered accountant (CA).'
    )
    expect(BILLING_ALERT_TEXT.taxCreditNoteLate('CN/27-28/00001', 'INV/26-27/00001', 2027)).toBe(
      'Credit note CN/27-28/00001 for INV/26-27/00001 was issued after 30 November 2027, so it gives no tax reduction. Tell your chartered accountant (CA).'
    )
  })
})
