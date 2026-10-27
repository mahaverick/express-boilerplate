/**
 * @file The tax run for one workspace: a planner that reads the provider and
 * the database with no lock held, and a runner that issues what the plan
 * lists through `issueInvoice` and `issueCreditNote`, each in its own
 * transaction, then raises the staff alerts after the commits. Running twice
 * is safe: each issue re-checks its payment or refund under the billing row
 * lock. A provider error fails the run for the job's retry; documents issued
 * before it stay issued.
 *
 * Triggers: every sync that ends `synced` (`queueTaxReconcile`), a refund
 * webhook or one that names no known subscription
 * (`queueTaxReconcileForPayment`), the daily refund sweep and the one-time
 * backfill step (the billing scheduler). None of them rejects.
 */
import { gstSellerConfig } from '@/configs/billing.config'
import type { BillingAlertKind } from '@/constants/billing.constants'
import { TAX_MAX_TRACKED_SUBSCRIPTIONS, TAX_REFUND_LOOKBACK_DAYS } from '@/constants/gst.constants'
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import { addTaxReconcileJob, type BillingTaxReconcileJobData } from '@/jobs/billing.job'
import { BillingRepository, type ProviderScope } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { sendTaxDocumentIssued } from '@/services/billing/billing-emails.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { issueCreditNote, issueInvoice } from '@/services/billing/tax-documents.service'
import { logger } from '@/services/logger.service'
import type { BillingProviderClient, ProviderCharge, ProviderRefund } from '@/types/billing'
import type {
  PlannedCreditNote,
  PlannedHeldRefund,
  PlannedHold,
  PlannedInvoice,
  TaxPlan,
  TaxReconcileReport,
} from '@/types/tax'
import { BILLING_ALERT_TEXT } from '@/utilities/billing-alert-text.utilities'
import { isOtherProvider } from '@/utilities/billing-rules.utilities'
import {
  financialYearEndYear,
  financialYearOf,
  isLateInvoice,
  istDate,
  TAX_TEXT_PATTERN,
} from '@/utilities/gst.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const taxRepository = new TaxRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The longest message `billing_alerts.message` stores.
 */
const ALERT_MESSAGE_MAX_LENGTH = 280

/**
 * A billing period at least this long reads as yearly when the
 * subscription's price can't be read.
 */
const YEARLY_PERIOD_MIN_DAYS = 300

/**
 * The reason a credit note for a provider refund prints.
 */
const REFUND_CREDIT_NOTE_REASON = 'Refund'

/**
 * The plan name an invoice line prints when the plan's own name holds a
 * character the PDF font can't draw.
 */
const PRINTABLE_PLAN_NAME_FALLBACK = 'Paid plan'

/**
 * Month names as a document date prints them.
 */
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * The plan name and interval a subscription's invoice line prints.
 */
interface PlanLine {
  name: string
  interval: 'month' | 'year'
}

/**
 * A charge whose refunds a run may credit: invoiced before, or planned now.
 */
interface Creditable {
  paymentId: string
  invoiceId: string | null
  remainingMinor: number
  /**
   * When it was paid, or null for a hinted invoice whose charge this run did not list.
   */
  paidAt: Date | null
}

/**
 * A plan that does nothing, for a reason.
 * @param skipped - Why.
 * @returns The plan.
 */
function skippedPlan(skipped: NonNullable<TaxPlan['skipped']>): TaxPlan {
  return { skipped, invoices: [], creditNotes: [], holds: [], overCredits: [], heldRefunds: [] }
}

/**
 * A plan name as an invoice line prints it: the name when the PDF font can
 * draw it (`TAX_TEXT_PATTERN`), else `Paid plan`.
 * @param name - The plan's name.
 * @returns The printable name.
 */
function printablePlanName(name: string): string {
  return TAX_TEXT_PATTERN.test(name) ? name : PRINTABLE_PLAN_NAME_FALLBACK
}

/**
 * The IST day of an instant as a document prints it, such as `26 Oct 2026`.
 * @param at - The instant.
 * @returns The date text.
 */
function documentDate(at: Date): string {
  const [year, month, day] = istDate(at).split('-')
  return `${String(Number(day))} ${SHORT_MONTHS[Number(month) - 1] ?? ''} ${year ?? ''}`
}

/**
 * Every paid charge of a subscription. A subscription the provider refuses
 * to read (a 4xx a retry can't change) is skipped and logged by its id, so
 * one unknown subscription never fails the workspace's run.
 * @param provider - The payment provider.
 * @param subscriptionId - The subscription.
 * @returns Its charges, or none when the provider refused.
 * @throws {ProviderError} When the read can still succeed on a retry.
 */
async function paidChargesOf(
  provider: BillingProviderClient,
  subscriptionId: string
): Promise<ProviderCharge[]> {
  try {
    return await provider.listPaidCharges(subscriptionId)
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      logger.warn('A tax run skipped a subscription the provider refused to read', {
        subscriptionId,
      })
      return []
    }
    throw error
  }
}

/**
 * Every refund of a payment. A payment the provider refuses to read (a 4xx a
 * retry can't change) is skipped and logged by its id, as `paidChargesOf`
 * skips a subscription, so one unknown payment never fails the run.
 * @param provider - The payment provider.
 * @param paymentId - The payment.
 * @returns Its refunds, or none when the provider refused.
 * @throws {ProviderError} When the read can still succeed on a retry.
 */
async function refundsOf(
  provider: BillingProviderClient,
  paymentId: string
): Promise<ProviderRefund[]> {
  try {
    return await provider.listRefunds(paymentId)
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      logger.warn('A tax run skipped a payment whose refunds the provider refused to read', {
        paymentId,
      })
      return []
    }
    throw error
  }
}

/**
 * A payment's processed refunds, oldest first: a pending refund can still
 * fail, and a failed one returned nothing.
 * @param provider - The payment provider.
 * @param paymentId - The payment.
 * @returns The processed refunds.
 * @throws {ProviderError} When the read can still succeed on a retry.
 */
async function processedRefundsOf(
  provider: BillingProviderClient,
  paymentId: string
): Promise<ProviderRefund[]> {
  const listed = await refundsOf(provider, paymentId)
  return listed
    .filter((refund) => refund.status === 'processed')
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * The plan name and interval a subscription's notes name through their price.
 * @param provider - The payment provider.
 * @param subscriptionId - The subscription.
 * @returns The line, or undefined when the subscription or its price can't be read.
 * @throws {ProviderError} When the read can still succeed on a retry.
 */
async function planLineOf(
  provider: BillingProviderClient,
  subscriptionId: string
): Promise<PlanLine | undefined> {
  let priceId: string | undefined
  try {
    const subscription = await provider.fetchSubscription(subscriptionId)
    priceId = subscription.notes.priceId
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) return undefined
    throw error
  }
  if (priceId === undefined) return undefined
  const [price] = await planRepository.findPricesByIds([priceId])
  if (price === undefined) return undefined
  const plan = await planRepository.findPlan(price.planId)
  return plan === undefined
    ? undefined
    : { name: printablePlanName(plan.name), interval: price.interval }
}

/**
 * Builds invoice lines: `{plan name}, {Monthly|Yearly}, {start} to {end}`
 * with IST dates. The plan and interval come from the subscription's price,
 * read once per subscription; the fallback is the Paid plan, yearly for a
 * billing period of 300 days or more. A plan name the PDF font can't draw
 * prints as `Paid plan`.
 * @param provider - The payment provider.
 * @returns A function from a charge to its line.
 */
function invoiceLines(
  provider: BillingProviderClient
): (charge: ProviderCharge) => Promise<string> {
  const lines = new Map<string, Promise<PlanLine | undefined>>()
  let paidName: string | undefined
  return async (charge) => {
    let pending = lines.get(charge.subscriptionId)
    if (pending === undefined) {
      pending = planLineOf(provider, charge.subscriptionId)
      lines.set(charge.subscriptionId, pending)
    }
    const { billingStart, billingEnd } = charge
    let line = await pending
    if (line === undefined) {
      if (paidName === undefined) {
        const paid = await planRepository.findPlanByKey('paid')
        paidName = paid === undefined ? 'Paid' : printablePlanName(paid.name)
      }
      const isYearly =
        billingStart !== null &&
        billingEnd !== null &&
        billingEnd.getTime() - billingStart.getTime() >= YEARLY_PERIOD_MIN_DAYS * DAY_MS
      line = { name: paidName, interval: isYearly ? 'year' : 'month' }
    }
    const head = `${line.name}, ${line.interval === 'year' ? 'Yearly' : 'Monthly'}`
    return billingStart === null || billingEnd === null
      ? head
      : `${head}, ${documentDate(billingStart)} to ${documentDate(billingEnd)}`
  }
}

/**
 * Plan a workspace's tax run. It reads the provider and the database and
 * holds no lock.
 *
 * - Subscriptions: the billing row's current and next ones (when the row
 *   belongs to the running provider and mode), plus up to
 *   `TAX_MAX_TRACKED_SUBSCRIPTIONS` tracked ones, refunded duplicates included.
 * - Charges: every paid charge of each, paid on or after the registration
 *   date, oldest first (ties by payment id). One already invoiced or held is
 *   not planned again; an SEZ buyer's is held instead of invoiced.
 * - Refunds: read for each invoiced or planned charge that is hinted, or not
 *   fully credited and paid within `TAX_REFUND_LOOKBACK_DAYS`. Only
 *   processed refunds count, oldest first; one more than what is left to
 *   credit is an over-credit, never a capped note. A held charge's refunds
 *   are never credited: the same rule lists them (hinted, or paid within the
 *   lookback) as `heldRefunds`, and staff hear about each one.
 * - A payment or subscription the provider refuses to read (a 4xx) is
 *   skipped and logged.
 *
 * The provider's charge and refund lists stop at 100 pages and then return
 * what they read with a logged warning, so a subscription or payment with
 * more is planned in part; a later run sees the same pages. When a workspace
 * tracks more than `TAX_MAX_TRACKED_SUBSCRIPTIONS`, the newest are read and
 * a warning logs the workspace and the count.
 * @param tenantId - The workspace.
 * @param options - Payments to read refunds for whatever their age or credit, and the run time.
 * @param options.paymentIds - The hinted payments.
 * @param options.now - The run time; defaults to now.
 * @returns The plan, or why the run is skipped.
 * @throws {ProviderError} When a provider read can still succeed on a retry.
 */
export async function planTaxDocuments(
  tenantId: string,
  options: { paymentIds?: readonly string[]; now?: Date }
): Promise<TaxPlan> {
  const seller = gstSellerConfig()
  if (seller === null) return skippedPlan('registration_off')
  const provider = getBillingProvider()
  if (provider === null) return skippedPlan('payments_off')
  const row = await billingRepository.findByTenantId(tenantId)
  if (row === undefined) return skippedPlan('no_row')
  const scope: ProviderScope = { kind: provider.kind, mode: provider.mode }
  const now = options.now ?? new Date()
  const hints = new Set(options.paymentIds)

  const subscriptionIds = new Set<string>()
  if (!isOtherProvider(row, scope)) {
    for (const id of [row.providerSubscriptionId, row.nextSubscriptionId]) {
      if (id !== null) subscriptionIds.add(id)
    }
  }
  // One past the cap, to tell a truncated list from a full one.
  const tracked = await billingRepository.listTrackedSubscriptionIds(
    tenantId,
    scope,
    TAX_MAX_TRACKED_SUBSCRIPTIONS + 1
  )
  if (tracked.length > TAX_MAX_TRACKED_SUBSCRIPTIONS) {
    logger.warn('A tax run read only the newest tracked subscriptions of a workspace', {
      tenantId,
      count: await billingRepository.countTrackedSubscriptions(tenantId, scope),
      read: TAX_MAX_TRACKED_SUBSCRIPTIONS,
    })
  }
  for (const id of tracked.slice(0, TAX_MAX_TRACKED_SUBSCRIPTIONS)) subscriptionIds.add(id)

  const charges = new Map<string, ProviderCharge>()
  for (const subscriptionId of subscriptionIds) {
    for (const charge of await paidChargesOf(provider, subscriptionId)) {
      if (charge.paidAt.getTime() >= seller.effectiveFrom.getTime()) {
        charges.set(charge.paymentId, charge)
      }
    }
  }
  const ordered = [...charges.values()].toSorted(
    (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.paymentId.localeCompare(b.paymentId)
  )
  const issued = await taxRepository.listInvoicesByPayments(scope, [
    ...new Set([...charges.keys(), ...hints]),
  ])
  const invoiceByPayment = new Map(
    issued.flatMap((invoice) => (invoice.paymentId === null ? [] : [[invoice.paymentId, invoice]]))
  )
  const details = await taxRepository.findDetails(tenantId)
  const lineOf = invoiceLines(provider)

  const invoices: PlannedInvoice[] = []
  const holds: PlannedHold[] = []
  const creditable: Creditable[] = []
  // Held charges, already or in this plan, with when each was paid.
  const heldPayments = new Map<string, Date>()
  for (const charge of ordered) {
    const invoice = invoiceByPayment.get(charge.paymentId)
    if (invoice !== undefined) {
      creditable.push({
        paymentId: charge.paymentId,
        invoiceId: invoice.id,
        remainingMinor: invoice.totalMinor - invoice.creditedMinor,
        paidAt: charge.paidAt,
      })
      continue
    }
    if ((await taxRepository.findHeldByPayment(scope, charge.paymentId)) !== undefined) {
      heldPayments.set(charge.paymentId, charge.paidAt)
      continue
    }
    const description = await lineOf(charge)
    if (details?.isSez === true) {
      holds.push({ charge, description })
      heldPayments.set(charge.paymentId, charge.paidAt)
      continue
    }
    invoices.push({ charge, description, isLate: isLateInvoice(charge.paidAt, now) })
    creditable.push({
      paymentId: charge.paymentId,
      invoiceId: null,
      remainingMinor: charge.amountMinor,
      paidAt: charge.paidAt,
    })
  }
  // A hinted payment's invoice or hold counts even when its subscription was not read this run.
  for (const paymentId of hints) {
    if (charges.has(paymentId)) continue
    const invoice = invoiceByPayment.get(paymentId)
    if (invoice !== undefined) {
      creditable.push({
        paymentId,
        invoiceId: invoice.id,
        remainingMinor: invoice.totalMinor - invoice.creditedMinor,
        paidAt: null,
      })
      continue
    }
    const held = await taxRepository.findHeldByPayment(scope, paymentId)
    if (held?.tenantId === tenantId) heldPayments.set(paymentId, held.paidAt)
  }

  const lookbackFrom = now.getTime() - TAX_REFUND_LOOKBACK_DAYS * DAY_MS
  const creditNotes: PlannedCreditNote[] = []
  const overCredits: PlannedCreditNote[] = []
  for (const charge of creditable) {
    const isRecent = charge.paidAt !== null && charge.paidAt.getTime() >= lookbackFrom
    if (!hints.has(charge.paymentId) && (charge.remainingMinor <= 0 || !isRecent)) continue
    const refunds = await processedRefundsOf(provider, charge.paymentId)
    let remainingMinor = charge.remainingMinor
    for (const refund of refunds) {
      if ((await taxRepository.findCreditNoteByRefund(scope, refund.id)) !== undefined) continue
      const planned = {
        paymentId: charge.paymentId,
        invoiceId: charge.invoiceId,
        refund,
        remainingMinor,
      }
      if (refund.amountMinor > remainingMinor) {
        overCredits.push(planned)
      } else {
        creditNotes.push(planned)
        remainingMinor -= refund.amountMinor
      }
    }
  }
  const heldRefunds: PlannedHeldRefund[] = []
  for (const [paymentId, paidAt] of heldPayments) {
    if (!hints.has(paymentId) && paidAt.getTime() < lookbackFrom) continue
    for (const refund of await processedRefundsOf(provider, paymentId)) {
      heldRefunds.push({ paymentId, refund })
    }
  }
  return { skipped: null, invoices, creditNotes, holds, overCredits, heldRefunds }
}

/**
 * Insert a staff alert unless the workspace already has one of the kind
 * naming the text. A failure is logged: what it reports is committed.
 * @param tenantId - The workspace.
 * @param kind - The alert kind.
 * @param dedupeText - The id or text a repeat would name too.
 * @param message - The message.
 */
async function alertOnce(
  tenantId: string,
  kind: BillingAlertKind,
  dedupeText: string,
  message: string
): Promise<void> {
  try {
    if (await billingRepository.hasAlertNaming(tenantId, kind, dedupeText)) return
    await billingRepository.insertAlert({
      kind,
      tenantId,
      message: message.slice(0, ALERT_MESSAGE_MAX_LENGTH),
    })
  } catch (error) {
    logger.error('Could not record a billing alert', { error, tenantId, kind })
  }
}

/**
 * Raise the staff alert for a committed credit note that gives no tax
 * reduction (`noTaxReduction`), deduplicated by a bounded text naming its
 * number (`Credit note CN/26-27/00001 for` never matches inside
 * `CN/26-27/000010`). The tax run and a staff member's manual note both
 * raise it. Does nothing for a note that still reduces tax. Never rejects.
 * @param tenantId - The workspace.
 * @param note - The committed credit note.
 */
export async function raiseLateCreditNoteAlert(
  tenantId: string,
  note: TaxDocumentRecord
): Promise<void> {
  const original = note.snapshot.original
  if (!note.noTaxReduction || original === null) return
  // The 30 November that ends the reduction falls in the year the invoice's financial year ends.
  const deadlineYear = financialYearEndYear(financialYearOf(new Date(original.issuedAt)))
  await alertOnce(
    tenantId,
    'tax_credit_note_late',
    `Credit note ${note.number} for `,
    BILLING_ALERT_TEXT.taxCreditNoteLate(note.number, original.number, deadlineYear)
  )
}

/**
 * A refund more than what is left to credit on its invoice.
 */
interface OverCredit {
  invoiceId: string
  refundId: string
  amountMinor: number
  remainingMinor: number
}

/**
 * A document a run issued, with when its payment or refund happened, for the
 * owners' email.
 */
interface IssuedDocument {
  document: TaxDocumentRecord
  occurredAt: Date
}

/**
 * What a run committed that staff hear about.
 */
interface RunAlerts {
  /**
   * The numbers of invoices issued more than 30 days after payment, in
   * issue order.
   */
  lateInvoiceNumbers: string[]
  /**
   * The credit notes issued with no tax reduction.
   */
  lateNotes: TaxDocumentRecord[]
  newHolds: ProviderCharge[]
  overCredits: OverCredit[]
  /**
   * The processed refunds of held charges, which staff credit by hand.
   */
  heldRefunds: PlannedHeldRefund[]
  /**
   * Every document the run issued, in issue order.
   */
  issued: IssuedDocument[]
}

/**
 * Email the owners a link to each document a run issued, after the commits.
 * Never rejects: `sendTaxDocumentIssued` logs a failure and goes on.
 * @param issued - What the run issued.
 * @param now - The run time.
 */
async function mailIssuedDocuments(issued: readonly IssuedDocument[], now: Date): Promise<void> {
  for (const { document, occurredAt } of issued) {
    await sendTaxDocumentIssued(document, now, occurredAt)
  }
}

/**
 * Raise the staff alerts for what a run committed. One `tax_invoice_late`
 * covers every late invoice; each late credit note, new SEZ hold, refund of
 * a held charge and over-credit raises its own, deduplicated by a bounded
 * text that names its number, payment id or refund id (`Credit note
 * CN/26-27/00001 for` never matches inside `CN/26-27/000010`). Never rejects.
 * @param tenantId - The workspace.
 * @param alerts - What the run committed.
 */
async function raiseRunAlerts(tenantId: string, alerts: RunAlerts): Promise<void> {
  const { lateInvoiceNumbers } = alerts
  const first = lateInvoiceNumbers.at(0)
  const last = lateInvoiceNumbers.at(-1)
  if (first !== undefined && last !== undefined) {
    const message = BILLING_ALERT_TEXT.taxInvoiceLate(lateInvoiceNumbers.length, first, last)
    await alertOnce(tenantId, 'tax_invoice_late', message, message)
  }
  for (const note of alerts.lateNotes) await raiseLateCreditNoteAlert(tenantId, note)
  for (const charge of alerts.newHolds) {
    await alertOnce(
      tenantId,
      'tax_held_sez',
      `Payment ${charge.paymentId} of ₹`,
      BILLING_ALERT_TEXT.taxHeldSez(charge.paymentId, charge.amountMinor)
    )
  }
  for (const { paymentId, refund } of alerts.heldRefunds) {
    await alertOnce(
      tenantId,
      'tax_held_sez',
      `(refund ${refund.id})`,
      BILLING_ALERT_TEXT.taxHeldSezRefunded(paymentId, refund.amountMinor, refund.id)
    )
  }
  for (const over of alerts.overCredits) {
    let invoiceNumber = over.invoiceId
    try {
      const invoice = await taxRepository.findDocument(tenantId, over.invoiceId)
      invoiceNumber = invoice?.number ?? over.invoiceId
    } catch (error) {
      logger.error('Could not read an invoice for an over-credit alert', { error, tenantId })
    }
    await alertOnce(
      tenantId,
      'tax_issue_failed',
      `Refund ${over.refundId} of `,
      BILLING_ALERT_TEXT.taxRefundOverCredit(
        over.refundId,
        over.amountMinor,
        over.remainingMinor,
        invoiceNumber
      )
    )
  }
}

/**
 * Run a workspace's tax run: plan it, issue each invoice (or hold), then
 * each credit note, then raise the alerts for what committed
 * (`raiseRunAlerts`) and email the owners a link to each
 * (`mailIssuedDocuments`). Both run even when an issue fails part way, before
 * its error is rethrown: the retry finds those documents issued and would
 * never raise or send them.
 * @param tenantId - The workspace.
 * @param options - Payments to read refunds for whatever their age or credit, and the run time.
 * @param options.paymentIds - The hinted payments.
 * @param options.now - The run time and issue date, a test seam; by default the run time is now and each document's issue time is the database clock read after its counter lock.
 * @returns What the run did.
 * @throws {ProviderError} When a provider read fails; documents issued before it stay issued.
 */
export async function reconcileTaxDocuments(
  tenantId: string,
  options: { paymentIds?: readonly string[]; now?: Date } = {}
): Promise<TaxReconcileReport> {
  const now = options.now ?? new Date()
  const plan = await planTaxDocuments(tenantId, { ...options, now })
  const report: TaxReconcileReport = {
    skipped: plan.skipped,
    issued: { invoices: 0, creditNotes: 0 },
    held: 0,
    late: { invoices: 0, creditNotes: 0 },
    overCredits: 0,
  }
  const provider = getBillingProvider()
  if (plan.skipped !== null || provider === null) return report
  const scope: ProviderScope = { kind: provider.kind, mode: provider.mode }
  const alerts: RunAlerts = {
    lateInvoiceNumbers: [],
    lateNotes: [],
    newHolds: [],
    overCredits: [],
    heldRefunds: [],
    issued: [],
  }
  try {
    await issuePlan(tenantId, plan, scope, options.now, report, alerts)
  } finally {
    // Each step stands alone, so a throw in one never skips the other.
    try {
      await raiseRunAlerts(tenantId, alerts)
    } catch (error) {
      logger.error('Could not raise the alerts of a tax run', { error, tenantId })
    }
    try {
      await mailIssuedDocuments(alerts.issued, now)
    } catch (error) {
      logger.error('Could not mail the documents of a tax run', { error, tenantId })
    }
  }
  report.late = { invoices: alerts.lateInvoiceNumbers.length, creditNotes: alerts.lateNotes.length }
  report.overCredits = alerts.overCredits.length
  return report
}

/**
 * Issue a plan's invoices and holds, then its credit notes, counting into
 * the report and collecting what staff hear about as each one commits.
 * @param tenantId - The workspace.
 * @param plan - The plan.
 * @param scope - The running provider and mode.
 * @param now - The issue time a test passes, or undefined for the database clock.
 * @param report - The run's report, counted into.
 * @param alerts - What staff hear about, collected into.
 * @throws {Error} When an issue fails; what committed before it is already collected.
 */
async function issuePlan(
  tenantId: string,
  plan: TaxPlan,
  scope: ProviderScope,
  now: Date | undefined,
  report: TaxReconcileReport,
  alerts: RunAlerts
): Promise<void> {
  const invoiceIdByPayment = new Map<string, string>()
  for (const { charge, description } of [...plan.invoices, ...plan.holds]) {
    const result = await issueInvoice(tenantId, { ...charge, description }, scope, now)
    if (result.outcome === 'issued') {
      report.issued.invoices += 1
      invoiceIdByPayment.set(charge.paymentId, result.document.id)
      alerts.issued.push({ document: result.document, occurredAt: charge.paidAt })
      if (isLateInvoice(charge.paidAt, result.document.issuedAt)) {
        alerts.lateInvoiceNumbers.push(result.document.number)
      }
    } else if (result.outcome === 'held') {
      report.held += 1
      alerts.newHolds.push(charge)
    }
  }

  /**
   * The invoice a planned note credits: planned with it, issued by this
   * run, or issued by another.
   * @param planned - The planned note.
   * @returns The invoice id, or undefined when the charge was held instead.
   */
  const invoiceOf = async (planned: PlannedCreditNote): Promise<string | undefined> => {
    const known = planned.invoiceId ?? invoiceIdByPayment.get(planned.paymentId)
    if (known !== undefined) return known
    const invoice = await taxRepository.findInvoiceByPayment(scope, planned.paymentId)
    return invoice?.id
  }

  for (const planned of plan.overCredits) {
    const invoiceId = await invoiceOf(planned)
    if (invoiceId === undefined) continue
    alerts.overCredits.push({
      invoiceId,
      refundId: planned.refund.id,
      amountMinor: planned.refund.amountMinor,
      remainingMinor: planned.remainingMinor,
    })
  }
  // A charge planned as held but invoiced at issue (no longer an SEZ unit) gets its note next run.
  for (const planned of plan.heldRefunds) {
    if ((await taxRepository.findHeldByPayment(scope, planned.paymentId)) !== undefined) {
      alerts.heldRefunds.push(planned)
    }
  }
  for (const planned of plan.creditNotes) {
    const invoiceId = await invoiceOf(planned)
    // Held after the plan was read: a held charge's refunds are never credited.
    if (invoiceId === undefined) continue
    const { refund } = planned
    const result = await issueCreditNote(
      tenantId,
      invoiceId,
      { amountMinor: refund.amountMinor, refundId: refund.id, reason: REFUND_CREDIT_NOTE_REASON },
      now
    )
    if (result.outcome === 'issued') {
      report.issued.creditNotes += 1
      const { document } = result
      alerts.issued.push({ document, occurredAt: refund.createdAt })
      if (document.noTaxReduction) alerts.lateNotes.push(document)
    } else if (result.outcome === 'over_credit') {
      alerts.overCredits.push({
        invoiceId,
        refundId: refund.id,
        amountMinor: refund.amountMinor,
        remainingMinor: result.remainingMinor,
      })
    }
  }
}

/**
 * Whether a tax run can do anything: registration and payments are on.
 * @returns The running provider's scope, or undefined when either is off.
 */
function taxScope(): ProviderScope | undefined {
  if (gstSellerConfig() === null) return undefined
  const provider = getBillingProvider()
  return provider === null ? undefined : { kind: provider.kind, mode: provider.mode }
}

/**
 * Queue a workspace's tax run. Does nothing with registration or payments
 * off. Never rejects: a failure is logged, and the next trigger or the daily
 * steps queue it again.
 * @param tenantId - The workspace.
 * @param paymentIds - Payments to read refunds for, if any.
 */
export async function queueTaxReconcile(tenantId: string, paymentIds?: string[]): Promise<void> {
  try {
    if (taxScope() === undefined) return
    await addTaxReconcileJob({ tenantId, ...(paymentIds !== undefined && { paymentIds }) })
  } catch (error) {
    logger.error('Could not queue a tax run', { error, tenantId })
  }
}

/**
 * Queue a tax run, hinted with a payment, for the workspace a payment or
 * subscription belongs to: the one it was invoiced or held for, else the one
 * that tracks the subscription in any role, else the one whose billing row
 * holds it. Queues nothing when none is found, or with registration or
 * payments off. Never rejects.
 * @param scope - The provider and mode the event came from.
 * @param ids - The payment and subscription the event named or resolved to.
 * @param ids.paymentId - The payment, if any.
 * @param ids.subscriptionId - The subscription, if any.
 */
export async function queueTaxReconcileForPayment(
  scope: ProviderScope,
  ids: { paymentId: string | null; subscriptionId: string | null }
): Promise<void> {
  try {
    if (taxScope() === undefined) return
    const { paymentId, subscriptionId } = ids
    const tenantId =
      (paymentId === null
        ? undefined
        : await taxRepository.findTenantIdForPayment(scope, paymentId)) ??
      // Tracked in any role, else held by a billing row as current, pending or next.
      (subscriptionId === null
        ? undefined
        : await billingRepository.findTenantIdBySubscription(scope, subscriptionId))
    if (tenantId === undefined) return
    await addTaxReconcileJob({ tenantId, ...(paymentId !== null && { paymentIds: [paymentId] }) })
  } catch (error) {
    logger.error('Could not queue a tax run for a payment', {
      error,
      paymentId: ids.paymentId,
      subscriptionId: ids.subscriptionId,
    })
  }
}

/**
 * Tell staff a workspace's tax run gave up after every retry: one
 * `tax_issue_failed` alert per workspace and IST day. Never rejects: it runs
 * from the Worker's `failed` listener.
 * @param data - The job's payload.
 * @param error - What its last attempt threw.
 */
export async function recordTaxReconcileFailure(
  data: BillingTaxReconcileJobData,
  error: Error
): Promise<void> {
  const { tenantId } = data
  logger.error('A tax run failed after every retry', { error, tenantId })
  const date = istDate(new Date())
  await alertOnce(
    tenantId,
    'tax_issue_failed',
    `workspace ${tenantId} were not issued on ${date}`,
    BILLING_ALERT_TEXT.taxIssueFailed(tenantId, date)
  )
}
