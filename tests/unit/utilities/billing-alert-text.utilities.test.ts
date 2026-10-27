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
    expect(BILLING_ALERT_TEXT.webhookFailed('evt_1', 'subscription.charged')).toContain(
      'evt_1 (subscription.charged) failed'
    )
    expect(
      BILLING_ALERT_TEXT.stillRetrying('Razorpay event evt_1 (subscription.charged)')
    ).toContain('evt_1 (subscription.charged) is still retrying')
  })

  it('words the tax alerts as the API contract gives them', () => {
    expect(BILLING_ALERT_TEXT.taxHeldSez('pay_P1', 99_900)).toBe(
      "Payment pay_P1 of ₹999 is held: this workspace is an SEZ unit. Issue its tax invoice by hand, then mark it resolved on the workspace's Billing tab."
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
      '3 tax invoices, INV/26-27/00001 to INV/26-27/00003, were issued more than 30 days after payment. Tell your CA.'
    )
    expect(BILLING_ALERT_TEXT.taxInvoiceLate(1, 'INV/26-27/00007', 'INV/26-27/00007')).toBe(
      '1 tax invoice, INV/26-27/00007, was issued more than 30 days after payment. Tell your CA.'
    )
    expect(BILLING_ALERT_TEXT.taxCreditNoteLate('CN/27-28/00001', 'INV/26-27/00001', 2027)).toBe(
      'Credit note CN/27-28/00001 for INV/26-27/00001 was issued after 30 November 2027, so it gives no tax reduction. Tell your CA.'
    )
  })
})
