/**
 * @file Issues GST tax documents: an invoice for a paid charge, a credit
 * note against an invoice (for a processed refund, or by staff), and the
 * hold of an SEZ buyer's charge. Each runs in one transaction that takes the
 * workspace's billing row first, then (for a credit note) the invoice row,
 * then the shared number counter last, held for one insert. The counter bump
 * and the document insert commit or roll back together, so the series has
 * no gap. Nothing here calls the payment provider or sends mail; callers
 * raise alerts and send mail after the commit. Also the owner's reads of
 * issued documents: the list and the PDF download.
 */
import { gstSellerConfig, type GstSellerConfig } from '@/configs/billing.config'
import type { GstState } from '@/constants/gst.constants'
import type { TaxDocumentRecord, TenantTaxDetailsRecord } from '@/database/models/tax.model'
import { notFoundError } from '@/errors/not-found-errors'
import { presentTaxDocument, type TaxDocumentView } from '@/presenters/tax.presenter'
import { BillingRepository, type ProviderScope } from '@/repositories/billing.repository'
import { ownerDocumentList, TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import { assertTaxReadable } from '@/services/billing/tax-details.service'
import { renderTaxDocumentPdf } from '@/services/billing/tax-pdf.service'
import { db, type DbTransaction, withTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import type { Actor } from '@/types/actor'
import type { ProviderCharge } from '@/types/billing'
import type { TaxDocumentSnapshot } from '@/types/tax'
import {
  creditNoteAmounts,
  financialYearOf,
  formatDocumentNumber,
  isLateCreditNote,
  istDate,
  normaliseQuotes,
  placeOfSupply,
  splitInclusive,
  stateOf,
  supplyKind,
  TAX_TEXT_PATTERN,
  type TaxAmounts,
} from '@/utilities/gst.utilities'
import { listPage, type ListPage } from '@/utilities/list-page.utilities'
import type { TaxDocumentListQuery } from '@/validators/tax.validators'

const billingRepository = new BillingRepository()
const taxRepository = new TaxRepository()
const tenantRepository = new TenantRepository()

/**
 * What `buildSnapshot` freezes into a document.
 */
export interface SnapshotInput {
  seller: GstSellerConfig
  /**
   * The workspace's tax details at issue, or undefined when it never saved any.
   */
  details: TenantTaxDetailsRecord | undefined
  /**
   * The buyer's name when the workspace has no tax details: its printable
   * name at issue (`buyerNameOf`).
   */
  tenantName: string
  description: string
  billingPeriod: TaxDocumentSnapshot['billingPeriod']
  amounts: TaxAmounts
  supply: TaxDocumentSnapshot['supply']
  placeOfSupply: GstState
  reference: TaxDocumentSnapshot['reference']
  original: TaxDocumentSnapshot['original']
  reason: string | null
}

/**
 * What `issueInvoice` did: issued an invoice, found the payment already
 * invoiced or held, held it for an SEZ buyer, or found no billing row.
 */
export type IssueInvoiceResult =
  | { outcome: 'issued'; document: TaxDocumentRecord }
  | { outcome: 'exists' | 'held' | 'no_row' }

/**
 * What `issueCreditNote` did. `exists` (the refund is already credited) and
 * `over_credit` (the note would credit more than the invoice) carry what is
 * left to credit; `repeated` carries the same staff member's note of the
 * same amount and reason from the last 10 minutes; `no_row` means no billing
 * row, or no invoice of this workspace by that id.
 */
export type IssueCreditNoteResult =
  | { outcome: 'issued'; document: TaxDocumentRecord }
  | { outcome: 'exists' | 'over_credit'; remainingMinor: number }
  | { outcome: 'repeated'; document: TaxDocumentRecord }
  | { outcome: 'no_row' | 'not_an_invoice' }

/**
 * The amount and source of one credit note.
 */
export interface CreditNoteInput {
  amountMinor: number
  /**
   * The provider refund it credits, or null for a staff credit note.
   */
  refundId: string | null
  /**
   * Why it was issued. It is printed on the credit note the customer
   * downloads, so it holds only what `TAX_TEXT_PATTERN` allows.
   */
  reason: string
}

/**
 * A state by code, failing on a code no stored row should hold.
 * @param code - The two-digit state code.
 * @returns The state.
 * @throws {Error} When the code is not a selectable state.
 */
function requireState(code: string): GstState {
  const state = stateOf(code)
  if (state === undefined) throw new Error(`Unknown GST state code ${code}`)
  return state
}

/**
 * The seller config, which every issue needs.
 * @returns The config.
 * @throws {Error} When GST registration is off; callers check it first.
 */
function requireSeller(): GstSellerConfig {
  const seller = gstSellerConfig()
  if (seller === null) throw new Error('GST registration is off, so no tax document is issued.')
  return seller
}

/**
 * The buyer name a document prints for a workspace with no tax details: its
 * name, or its slug when the name holds a character the PDF font can't draw
 * (`TAX_TEXT_PATTERN`), such as Devanagari.
 * @param tenant - The workspace.
 * @param tenant.name - Its name.
 * @param tenant.slug - Its slug.
 * @returns The printable name.
 */
function buyerNameOf(tenant: { name: string; slug: string }): string {
  const name = normaliseQuotes(tenant.name)
  return TAX_TEXT_PATTERN.test(name) ? name : tenant.slug
}

/**
 * Freeze every printed field of a document. With no tax details the buyer is
 * the workspace by its name at issue, with no GSTIN and no address: an
 * unregistered buyer. The address prints line 1, line 2, then the city and
 * PIN code on one line, leaving out what is empty.
 * @param input - The seller, buyer source, amounts and references.
 * @returns The snapshot.
 */
export function buildSnapshot(input: SnapshotInput): TaxDocumentSnapshot {
  const { details, seller } = input
  const buyer: TaxDocumentSnapshot['buyer'] =
    details === undefined
      ? {
          legalName: input.tenantName,
          gstin: null,
          addressLines: [],
          state: null,
          source: 'workspace',
        }
      : {
          legalName: details.legalName,
          gstin: details.gstin,
          addressLines: [
            details.addressLine1,
            details.addressLine2,
            [details.city, details.pincode].filter(Boolean).join(' '),
          ].filter((line): line is string => typeof line === 'string' && line !== ''),
          state: requireState(details.stateCode),
          source: 'tax_details',
        }
  return {
    version: 1,
    seller: {
      legalName: seller.legalName,
      addressLines: seller.addressLines,
      gstin: seller.gstin,
      state: requireState(seller.stateCode),
    },
    buyer,
    placeOfSupply: input.placeOfSupply,
    supply: input.supply,
    sacCode: seller.sacCode,
    description: input.description,
    billingPeriod: input.billingPeriod,
    amounts: input.amounts,
    reference: input.reference,
    original: input.original,
    reason: input.reason,
  }
}

/**
 * Thrown inside an issue transaction when the issue time read after the
 * counter lock falls in another financial year than the series locked, so
 * the transaction rolls back (the counter bump with it) and the issue runs
 * again in that year.
 */
class FinancialYearMoved extends Error {
  readonly financialYear: string

  /**
   * @param financialYear - The year the issue time falls in.
   */
  constructor(financialYear: string) {
    super(`The issue time fell in financial year ${financialYear}, not the one locked`)
    this.name = 'FinancialYearMoved'
    this.financialYear = financialYear
  }
}

/**
 * Run an issue in the financial year of its issue time. The first attempt
 * guesses the year from `now`, or from this process's clock; when the time
 * read after the counter lock falls in another year (`FinancialYearMoved`),
 * it runs once more in that year. A second move fails the issue, and the
 * tax run's retry tries again.
 * @param now - The issue time a test passes, or undefined for the database clock.
 * @param issue - One attempt, given the year to number in.
 * @returns What the attempt that numbered in the right year returned.
 * @throws {FinancialYearMoved} When the year moved on both attempts.
 */
async function inIssueYear<T>(
  now: Date | undefined,
  issue: (financialYear: string) => Promise<T>
): Promise<T> {
  try {
    return await issue(financialYearOf(now ?? new Date()))
  } catch (error) {
    if (!(error instanceof FinancialYearMoved)) throw error
    return issue(error.financialYear)
  }
}

/**
 * A document's issue time, read after its counter lock: `now` when a test
 * passes one, else the database clock. Read under the lock, it dates the
 * documents of a series in the order their numbers were allocated.
 * @param now - The issue time a test passes, or undefined.
 * @param financialYear - The year whose counter is locked.
 * @param tx - The issue transaction.
 * @returns The issue time.
 * @throws {FinancialYearMoved} When the time falls in another financial year.
 */
async function issueTimeAfterCounter(
  now: Date | undefined,
  financialYear: string,
  tx: DbTransaction
): Promise<Date> {
  const issuedAt = now ?? (await taxRepository.readClock(tx))
  const actual = financialYearOf(issuedAt)
  if (actual !== financialYear) throw new FinancialYearMoved(actual)
  return issuedAt
}

/**
 * Issue the tax invoice for a paid charge, or hold it when the buyer is an
 * SEZ unit. In one transaction: the billing row, then a re-check that the
 * payment has no invoice or hold, then the tax details (unlocked, frozen into
 * the snapshot), then the number and the issue time read after the counter
 * lock (`inIssueYear`), the insert and the audit entry. The counter stays
 * locked through the insert and its audit entry.
 * @param tenantId - The workspace.
 * @param charge - The paid charge and the line it prints.
 * @param scope - The provider and mode the charge came from.
 * @param now - The issue time, a test seam; by default the database clock read after the counter lock.
 * @returns What happened.
 * @throws {Error} When GST registration is off.
 */
export async function issueInvoice(
  tenantId: string,
  charge: ProviderCharge & { description: string },
  scope: ProviderScope,
  now?: Date
): Promise<IssueInvoiceResult> {
  const seller = requireSeller()
  return inIssueYear(now, (financialYear) =>
    withTransaction(async (tx): Promise<IssueInvoiceResult> => {
      const billing = await billingRepository.lockByTenantId(tenantId, tx)
      if (billing === undefined) return { outcome: 'no_row' }
      const invoiced = await taxRepository.findInvoiceByPayment(scope, charge.paymentId, tx)
      const held = await taxRepository.findHeldByPayment(scope, charge.paymentId, tx)
      if (invoiced !== undefined || held !== undefined) return { outcome: 'exists' }

      const details = await taxRepository.findDetails(tenantId, tx)
      if (details?.isSez === true) {
        const hold = await taxRepository.insertHeld(
          {
            tenantId,
            provider: scope.kind,
            providerMode: scope.mode,
            paymentId: charge.paymentId,
            subscriptionId: charge.subscriptionId,
            amountMinor: charge.amountMinor,
            paidAt: charge.paidAt,
          },
          tx
        )
        return { outcome: hold === undefined ? 'exists' : 'held' }
      }

      const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId, tx)
      if (tenant === undefined) {
        throw new Error(`Workspace ${tenantId} has a billing row but no row`)
      }
      const placeCode =
        details === undefined
          ? seller.stateCode
          : placeOfSupply({ gstin: details.gstin, stateCode: details.stateCode }, seller.stateCode)
      const supply = supplyKind(seller.stateCode, placeCode)
      const amounts = splitInclusive(charge.amountMinor, supply)
      const snapshot = buildSnapshot({
        seller,
        details,
        tenantName: buyerNameOf(tenant),
        description: charge.description,
        billingPeriod:
          charge.billingStart === null || charge.billingEnd === null
            ? null
            : { start: istDate(charge.billingStart), end: istDate(charge.billingEnd) },
        amounts,
        supply,
        placeOfSupply: requireState(placeCode),
        reference: { paymentId: charge.paymentId, refundId: null },
        original: null,
        reason: null,
      })

      const n = await taxRepository.allocateNumber('invoice', financialYear, tx)
      const issuedAt = await issueTimeAfterCounter(now, financialYear, tx)
      const document = await taxRepository.insertDocument(
        {
          type: 'invoice',
          number: formatDocumentNumber(seller.invoicePrefix, financialYear, n),
          financialYear,
          issuedAt,
          tenantId,
          provider: scope.kind,
          providerMode: scope.mode,
          paymentId: charge.paymentId,
          subscriptionId: charge.subscriptionId,
          totalMinor: amounts.totalMinor,
          taxableMinor: amounts.taxableMinor,
          cgstMinor: amounts.cgstMinor,
          sgstMinor: amounts.sgstMinor,
          igstMinor: amounts.igstMinor,
          supply,
          placeOfSupply: placeCode,
          buyerGstin: snapshot.buyer.gstin,
          snapshot,
        },
        tx
      )
      await record(
        {
          action: 'billing.tax_document_issued',
          actor: 'system',
          access: 'system',
          tenantId,
          targetId: document.id,
          metadata: { type: 'invoice' },
        },
        tx
      )
      return { outcome: 'issued', document }
    })
  )
}

/**
 * How long a staff member's manual credit note blocks a second one of the
 * same amount and reason against the same invoice: a double submit, or a
 * retry after a lost answer.
 */
const MANUAL_NOTE_REPEAT_MS = 10 * 60_000

/**
 * Issue a credit note against one of a workspace's invoices, for a processed
 * refund or, with `options.staff`, by hand. In one transaction: the staff
 * actor's platform role (admin or above) when staff issue it, then the
 * billing row, the invoice row, a re-check that the refund has no note (or,
 * by hand, that the same staff member issued no note of the same amount and
 * reason against it in the last 10 minutes), the amount already credited,
 * then the number and the issue time read after the counter lock
 * (`inIssueYear`), the insert and the audit entry. The counter stays locked
 * through the insert and its audit entry.
 *
 * The note keeps its invoice's seller, buyer, place of supply and supply,
 * and its amounts are the cumulative difference, so all notes together equal
 * the invoice. A note dated from 1 December after its invoice's financial
 * year gives no tax reduction (`noTaxReduction`). The reason is printed on
 * the note the customer downloads.
 * @param tenantId - The workspace.
 * @param invoiceId - The invoice to credit; another workspace's reads as not found.
 * @param credit - The amount, the refund (null by staff) and the reason, which the note prints.
 * @param now - The issue time, a test seam; by default the database clock read after the counter lock.
 * @param options - `staff.actor` when staff issue it by hand.
 * @param options.staff - The staff member issuing it.
 * @returns What happened.
 * @throws {RangeError} When the amount is not a positive whole number of paise; nothing is locked or written.
 * @throws {HttpError} 404 when the staff actor is no longer a platform admin.
 * @throws {Error} When GST registration is off.
 */
export async function issueCreditNote(
  tenantId: string,
  invoiceId: string,
  credit: CreditNoteInput,
  now?: Date,
  options: { staff?: { actor: Actor } } = {}
): Promise<IssueCreditNoteResult> {
  if (!Number.isSafeInteger(credit.amountMinor) || credit.amountMinor <= 0) {
    throw new RangeError('A credit note amount must be a positive whole number of paise.')
  }
  const seller = requireSeller()
  const staff = options.staff
  return inIssueYear(now, (financialYear) =>
    withTransaction(async (tx): Promise<IssueCreditNoteResult> => {
      if (staff !== undefined) await assertStillPlatformRole(staff.actor, 'admin', tx)
      const billing = await billingRepository.lockByTenantId(tenantId, tx)
      if (billing === undefined) return { outcome: 'no_row' }
      // Scoped to the workspace: another workspace's document reads as unknown, whatever its type.
      const invoice = await taxRepository.lockInvoice(tenantId, invoiceId, tx)
      if (invoice === undefined) return { outcome: 'no_row' }
      if (invoice.type !== 'invoice') return { outcome: 'not_an_invoice' }

      const scope: ProviderScope = { kind: invoice.provider, mode: invoice.providerMode }
      const credited = await taxRepository.creditedBefore(invoice.id, tx)
      const remainingMinor = invoice.totalMinor - credited
      if (credit.refundId !== null) {
        const existing = await taxRepository.findCreditNoteByRefund(scope, credit.refundId, tx)
        if (existing !== undefined) return { outcome: 'exists', remainingMinor }
      }
      if (staff !== undefined) {
        const since = new Date(
          (now ?? (await taxRepository.readClock(tx))).getTime() - MANUAL_NOTE_REPEAT_MS
        )
        const repeated = await taxRepository.findRecentManualNote(
          { invoiceId: invoice.id, createdBy: staff.actor.userId, ...credit, since },
          tx
        )
        if (repeated !== undefined) return { outcome: 'repeated', document: repeated }
      }
      if (credit.amountMinor > remainingMinor) return { outcome: 'over_credit', remainingMinor }

      const amounts = creditNoteAmounts(
        {
          totalMinor: invoice.totalMinor,
          taxableMinor: invoice.taxableMinor,
          cgstMinor: invoice.cgstMinor,
          sgstMinor: invoice.sgstMinor,
          igstMinor: invoice.igstMinor,
          ratePercent: invoice.snapshot.amounts.ratePercent,
          supply: invoice.supply,
        },
        credited,
        credit.amountMinor
      )
      const snapshot: TaxDocumentSnapshot = {
        ...invoice.snapshot,
        amounts,
        reference: { paymentId: invoice.paymentId, refundId: credit.refundId },
        original: { number: invoice.number, issuedAt: invoice.issuedAt.toISOString() },
        reason: credit.reason,
      }

      const n = await taxRepository.allocateNumber('credit_note', financialYear, tx)
      const issuedAt = await issueTimeAfterCounter(now, financialYear, tx)
      const document = await taxRepository.insertDocument(
        {
          type: 'credit_note',
          number: formatDocumentNumber(seller.creditNotePrefix, financialYear, n),
          financialYear,
          issuedAt,
          tenantId,
          provider: invoice.provider,
          providerMode: invoice.providerMode,
          // A staff note credits no payment of its own; the snapshot still cites the invoice's.
          paymentId: credit.refundId === null ? null : invoice.paymentId,
          refundId: credit.refundId,
          subscriptionId: invoice.subscriptionId,
          originalDocumentId: invoice.id,
          totalMinor: amounts.totalMinor,
          taxableMinor: amounts.taxableMinor,
          cgstMinor: amounts.cgstMinor,
          sgstMinor: amounts.sgstMinor,
          igstMinor: amounts.igstMinor,
          supply: invoice.supply,
          placeOfSupply: invoice.placeOfSupply,
          buyerGstin: invoice.buyerGstin,
          snapshot,
          noTaxReduction: isLateCreditNote(invoice.financialYear, issuedAt),
          reason: credit.reason,
          createdBy: staff?.actor.userId ?? null,
        },
        tx
      )
      await (staff === undefined
        ? record(
            {
              action: 'billing.tax_document_issued',
              actor: 'system',
              access: 'system',
              tenantId,
              targetId: document.id,
              metadata: { type: 'credit_note' },
            },
            tx
          )
        : record(
            {
              action: 'billing.credit_note_issued_by_staff',
              actor: staff.actor,
              access: 'platform',
              tenantId,
              targetId: document.id,
              metadata: { invoiceId: invoice.id, reason: credit.reason },
            },
            tx
          ))
      return { outcome: 'issued', document }
    })
  )
}

/**
 * One page of a workspace's tax documents for its owner, newest first by
 * default, each with its links. It holds every document of the workspace,
 * including those of subscriptions with no invoice row (a refunded
 * duplicate). Readable while registration is on, or once the workspace has
 * documents.
 * @param tenantId - The workspace.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} 404 `tax_documents_disabled` while registration is off and the workspace has no documents.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listTaxDocuments(
  tenantId: string,
  query: TaxDocumentListQuery
): Promise<ListPage<TaxDocumentView>> {
  await assertTaxReadable(tenantId)
  const page = await listPage(db, ownerDocumentList(tenantId, query.filters.type), query.params)
  const references = await taxRepository.listRefsFor(page.items)
  return {
    ...page,
    items: page.items.map((document) => presentTaxDocument(document, references)),
  }
}

/**
 * One of a workspace's tax documents as a PDF, with the file name a
 * download saves it under (the number with `/` turned into `-`). Once the
 * bytes are built it records a `tax_document_downloaded` event with the
 * document type and where it was downloaded, never the number.
 * @param tenantId - The workspace.
 * @param id - The document id.
 * @param actor - The downloader.
 * @param surface - `web` for the customer app, `apex` for staff.
 * @returns The file name, the bytes and the document type.
 * @throws {HttpError} 404 `tax_documents_disabled` while registration is off and the workspace has no documents; 404 `tax_document_not_found` for an unknown id or another workspace's document.
 */
export async function getDocumentPdf(
  tenantId: string,
  id: string,
  actor: Actor,
  surface: 'web' | 'apex'
): Promise<{ filename: string; body: Buffer; type: TaxDocumentRecord['type'] }> {
  await assertTaxReadable(tenantId)
  const document = await taxRepository.findDocument(tenantId, id)
  if (document === undefined) throw notFoundError('taxDocument')
  const body = await renderTaxDocumentPdf(document)
  await emitDomainEvent(
    {
      type: 'tax_document_downloaded',
      tenantId,
      userId: actor.userId,
      documentType: document.type,
      surface,
      at: new Date(),
    },
    { access: surface === 'apex' ? 'platform' : 'member' }
  )
  return { filename: `${document.number.replaceAll('/', '-')}.pdf`, body, type: document.type }
}
