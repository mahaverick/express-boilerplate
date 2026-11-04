/**
 * @file The notification types this codebase produces: invitations, the
 * maintenance-mode notice, the six billing notices and the account deletion
 * alert.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  NOTIFICATION_TYPES,
  STAFF_ONLY_NOTIFICATION_TYPES,
} from '@/constants/notification.constants'

describe('NOTIFICATION_TYPES', () => {
  it('lists exactly the invitation, the maintenance-mode notice, the billing notices and the deletion alert', () => {
    expect(NOTIFICATION_TYPES).toEqual([
      'tenant_invitation',
      'maintenance_mode_changed',
      'billing_trial_ending',
      'billing_payment_failed',
      'billing_paid_cancelled',
      'billing_upgrade_requested',
      'billing_payer_left',
      'workspace_full',
      'account_deletion_requested',
    ])
  })

  it('keeps the maintenance-mode notice and the deletion alert staff-only', () => {
    expect(STAFF_ONLY_NOTIFICATION_TYPES).toEqual([
      'maintenance_mode_changed',
      'account_deletion_requested',
    ])
  })
})
