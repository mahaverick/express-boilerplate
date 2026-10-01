/**
 * @file getEmailHealth over a window in 2001, which no other test writes to,
 * so the counts are exact: disjoint groups by current status, `queued`
 * left out, rates null without provider events (`undeliveredRate` still
 * computed), open and click rates over `general`-sender mail only, and the
 * by-template and top-10 by-domain tables.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmailMessageStatus, SenderClass } from '@/constants/email.constants'
import { getEmailHealth } from '@/services/platform-email.service'
import {
  addEvent,
  createTrackedMessage,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'

const NOW = new Date('2001-01-10T12:00:00.000Z')
const DAY_ONE = new Date('2001-01-04T06:00:00.000Z')
const TODAY = new Date('2001-01-10T06:00:00.000Z')

afterEach(async () => {
  await deleteTrackedEmailRows()
})

async function messageAt(
  createdAt: Date,
  status: EmailMessageStatus,
  options: { senderClass?: SenderClass; templateKey?: string; domain?: string } = {}
) {
  return createTrackedMessage({
    recipient: `h-${randomUUID()}@${options.domain ?? 'example.test'}`,
    createdAt,
    status,
    senderClass: options.senderClass ?? 'transactional',
    templateKey: options.templateKey ?? 'account_setup',
  })
}

describe('getEmailHealth', () => {
  it('counts messages in five disjoint groups per day, leaving queued out', async () => {
    await messageAt(DAY_ONE, 'queued')
    await messageAt(DAY_ONE, 'sent')
    await messageAt(DAY_ONE, 'deferred')
    await messageAt(TODAY, 'delivered')
    await messageAt(TODAY, 'bounced')
    await messageAt(TODAY, 'failed')
    await messageAt(TODAY, 'complained')
    await messageAt(TODAY, 'suppressed')

    const health = await getEmailHealth('7d', NOW)

    expect(health.days).toHaveLength(7)
    expect(health.days[0]).toEqual({
      date: '2001-01-04',
      delivered: 0,
      sent: 2,
      undelivered: 0,
      complained: 0,
      suppressed: 0,
    })
    expect(health.days[6]).toEqual({
      date: '2001-01-10',
      delivered: 1,
      sent: 0,
      undelivered: 2,
      complained: 1,
      suppressed: 1,
    })
    expect(health.totals).toEqual({
      delivered: 1,
      sent: 2,
      undelivered: 2,
      complained: 1,
      suppressed: 1,
      messages: 6,
      providerEvents: 0,
    })
  })

  it('answers null for every provider-dependent rate with no provider events, and still computes undeliveredRate', async () => {
    await messageAt(TODAY, 'sent')
    await messageAt(TODAY, 'sent')
    await messageAt(TODAY, 'sent')
    await messageAt(TODAY, 'failed')

    const { rates } = await getEmailHealth('7d', NOW)

    expect(rates.undeliveredRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 })
    for (const rate of [
      rates.deliveredRate,
      rates.bounceRate,
      rates.complaintRate,
      rates.openRate,
      rates.clickRate,
    ]) {
      expect(rate.value).toBeNull()
    }
  })

  it('computes provider rates once an event arrived, with hard bounces only in bounceRate', async () => {
    const delivered = await messageAt(TODAY, 'delivered')
    await addEvent(delivered.id, 'delivered', { receivedAt: TODAY })
    const bounced = await messageAt(TODAY, 'bounced')
    await addEvent(bounced.id, 'bounced', { bounceKind: 'hard', receivedAt: TODAY })
    await messageAt(TODAY, 'failed')
    await messageAt(TODAY, 'complained')

    const { rates, totals } = await getEmailHealth('7d', NOW)

    expect(totals.providerEvents).toBe(2)
    expect(rates.deliveredRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 })
    expect(rates.bounceRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 })
    expect(rates.complaintRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 })
    expect(rates.undeliveredRate).toEqual({ value: 0.5, numerator: 2, denominator: 4 })
  })

  it('counts opens and clicks over general-sender messages only', async () => {
    const opened = await messageAt(TODAY, 'delivered', { senderClass: 'general' })
    await addEvent(opened.id, 'opened', { receivedAt: TODAY })
    await addEvent(opened.id, 'opened', { receivedAt: TODAY })
    await addEvent(opened.id, 'clicked', { receivedAt: TODAY })
    await messageAt(TODAY, 'delivered', { senderClass: 'general' })
    const transactional = await messageAt(TODAY, 'delivered', { senderClass: 'transactional' })
    await addEvent(transactional.id, 'opened', { receivedAt: TODAY })

    const { rates } = await getEmailHealth('7d', NOW)

    expect(rates.openRate).toEqual({ value: 0.5, numerator: 1, denominator: 2 })
    expect(rates.clickRate).toEqual({ value: 0.5, numerator: 1, denominator: 2 })
  })

  it('breaks down by template and by the top 10 recipient domains, most messages first', async () => {
    await messageAt(TODAY, 'failed', { templateKey: 'tenant_invitation', domain: 'Big.example' })
    await messageAt(TODAY, 'complained', {
      templateKey: 'tenant_invitation',
      domain: 'big.example',
    })
    await messageAt(TODAY, 'sent', { templateKey: 'password_reset', domain: 'small.example' })
    await messageAt(TODAY, 'suppressed', { domain: 'small.example' })
    for (let index = 0; index < 10; index += 1) {
      await messageAt(TODAY, 'sent', { domain: `d${String(index)}.example` })
    }

    const health = await getEmailHealth('7d', NOW)

    expect(health.byTemplate[0]).toEqual({
      key: 'account_setup',
      messages: 10,
      undelivered: 0,
      complained: 0,
    })
    expect(health.byTemplate).toContainEqual({
      key: 'tenant_invitation',
      messages: 2,
      undelivered: 1,
      complained: 1,
    })
    expect(health.byDomain).toHaveLength(10)
    expect(health.byDomain[0]).toEqual({
      key: 'big.example',
      messages: 2,
      undelivered: 1,
      complained: 1,
    })
  })

  it('leaves out messages created outside the range', async () => {
    await messageAt(new Date('2001-01-03T23:59:59.999Z'), 'failed')
    await messageAt(new Date('2001-01-11T00:00:00.000Z'), 'failed')

    const health = await getEmailHealth('7d', NOW)

    expect(health.totals.messages).toBe(0)
    expect(health.rates.undeliveredRate.value).toBeNull()
  })
})
