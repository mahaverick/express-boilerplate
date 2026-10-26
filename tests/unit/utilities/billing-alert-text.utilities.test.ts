import { describe, expect, it } from 'vite-plus/test'
import {
  BILLING_ALERT_TEXT,
  cancelFailedMarker,
  LIFECYCLE_ALERT_TEXT,
} from '@/utilities/billing-alert-text.utilities'

describe('BILLING_ALERT_TEXT', () => {
  it('words a refund in rupees and keeps the provider ids', () => {
    expect(BILLING_ALERT_TEXT.duplicateRefunded('sub_FAKE1', 99_900, 'rfnd_FAKE1')).toBe(
      'We cancelled duplicate subscription sub_FAKE1 and refunded ₹999 in rfnd_FAKE1. No action needed.'
    )
    expect(BILLING_ALERT_TEXT.archivedRefunded('sub_FAKE1', 14_999_950, 'rfnd_FAKE1')).toBe(
      'We cancelled subscription sub_FAKE1, which an archived workspace adopted, and refunded ₹1,49,999.50 in rfnd_FAKE1. No action needed.'
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
    // A duplicate never became the workspace's current subscription, so the reconcile ignores it.
    expect(BILLING_ALERT_TEXT.duplicateCancelFailed('sub_X')).not.toContain(marker)
  })

  it('keeps the lifecycle text in every lifecycle cancel alert, which the retry searches for', () => {
    for (const text of [
      BILLING_ALERT_TEXT.lifecycleCancelFailed('sub_X'),
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
})
