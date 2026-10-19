/**
 * @file The notification types this codebase produces: invitations and the
 * maintenance-mode notice only.
 */
import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_TYPES,
  STAFF_ONLY_NOTIFICATION_TYPES,
} from '@/constants/notification.constants'

describe('NOTIFICATION_TYPES', () => {
  it('lists exactly the invitation and the maintenance-mode notice', () => {
    expect(NOTIFICATION_TYPES).toEqual(['tenant_invitation', 'maintenance_mode_changed'])
  })

  it('keeps the maintenance-mode notice staff-only', () => {
    expect(STAFF_ONLY_NOTIFICATION_TYPES).toEqual(['maintenance_mode_changed'])
  })
})
