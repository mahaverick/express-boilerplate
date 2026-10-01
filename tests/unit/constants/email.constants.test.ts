/**
 * @file Pins email tracking's value sets to the spec and to the CHECK
 * constraints built from them, and the status ranks every writer obeys.
 */
import { describe, expect, it } from 'vitest'
import {
  BOUNCE_KINDS,
  EMAIL_DETAIL_MAX_LENGTH,
  EMAIL_DETAIL_PATTERN,
  EMAIL_EVENT_TYPES,
  EMAIL_MESSAGE_GROUPS,
  EMAIL_MESSAGE_STATUSES,
  EMAIL_STATUS_RANK,
  FAILURE_ORIGINS,
  LIFT_REASON_MAX_LENGTH,
  SECRET_VARIABLE_PATTERN,
  SENDER_CLASSES,
  SUPPRESSION_REASONS,
} from '@/constants/email.constants'
import { MAX_REASON_LENGTH } from '@/validators/platform.validators'

describe('email value sets', () => {
  it('match the spec', () => {
    expect(EMAIL_MESSAGE_STATUSES).toEqual([
      'queued',
      'sent',
      'deferred',
      'delivered',
      'bounced',
      'complained',
      'failed',
      'suppressed',
    ])
    expect(EMAIL_EVENT_TYPES).toEqual([
      'delivered',
      'deferred',
      'bounced',
      'complained',
      'opened',
      'clicked',
      'failed',
    ])
    expect(BOUNCE_KINDS).toEqual(['hard', 'soft'])
    expect(SENDER_CLASSES).toEqual(['transactional', 'general'])
    expect(FAILURE_ORIGINS).toEqual(['send', 'provider', 'enqueue'])
    expect(SUPPRESSION_REASONS).toEqual(['hard_bounce', 'complaint'])
  })

  it('bounds a lift reason exactly as the staff reason validator does', () => {
    expect(LIFT_REASON_MAX_LENGTH).toBe(MAX_REASON_LENGTH)
  })
})

describe('EMAIL_STATUS_RANK', () => {
  it('ranks every status as the spec orders them', () => {
    expect(EMAIL_STATUS_RANK).toEqual({
      queued: 0,
      sent: 1,
      deferred: 2,
      delivered: 3,
      bounced: 4,
      failed: 4,
      complained: 5,
      suppressed: 0,
    })
  })

  it('never lets sent overwrite delivered', () => {
    expect(EMAIL_STATUS_RANK.sent).toBeLessThan(EMAIL_STATUS_RANK.delivered)
  })
})

describe('EMAIL_MESSAGE_GROUPS', () => {
  it('puts every status but queued in exactly one group', () => {
    const grouped = Object.values(EMAIL_MESSAGE_GROUPS).flat()
    expect(grouped.toSorted((a, b) => a.localeCompare(b))).toEqual(
      EMAIL_MESSAGE_STATUSES.filter((status) => status !== 'queued').toSorted((a, b) =>
        a.localeCompare(b)
      )
    )
    expect(new Set(grouped).size).toBe(grouped.length)
  })
})

describe('EMAIL_DETAIL_PATTERN', () => {
  it.each(['MESSAGE_REJECTED', 'PROVIDER_SUPPRESSED', 'GENERAL'])('accepts %s', (detail) => {
    expect(EMAIL_DETAIL_PATTERN.test(detail)).toBe(true)
  })

  it.each([
    ['lowercase hex, as a raw token is written', 'ab12'.repeat(8)],
    ['base64url, as an invitation token is written', 'Q2xpY2tlZC1saW5r_x-y'],
    ['a URL', 'HTTPS://EXAMPLE.TEST/X'],
    ['an empty string', ''],
  ])('refuses %s', (_label, detail) => {
    expect(EMAIL_DETAIL_PATTERN.test(detail)).toBe(false)
  })

  it('bounds detail at 32 characters, short of a 64-character hex token', () => {
    expect(EMAIL_DETAIL_MAX_LENGTH).toBe(32)
  })
})

describe('SECRET_VARIABLE_PATTERN', () => {
  it.each(['verificationUrl', 'resetUrl', 'setupUrl', 'acceptUrl', 'refreshToken'])(
    'matches %s',
    (key) => {
      expect(SECRET_VARIABLE_PATTERN.test(key)).toBe(true)
    }
  )

  it.each(['firstName', 'appName', 'tenantName', 'inviterName', 'role', 'expiresInDays'])(
    'does not match %s',
    (key) => {
      expect(SECRET_VARIABLE_PATTERN.test(key)).toBe(false)
    }
  )
})
