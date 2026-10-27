/**
 * @file Issues GST tax documents: an invoice for a paid charge, a credit
 * note against an invoice (for a processed refund, or by staff), and the
 * hold of an SEZ buyer's charge. Each runs in one transaction that takes the
 * workspace's billing row first, then (for a credit note) the invoice row,
 * then the shared number counter last, held for one insert. The counter bump
 * and the document insert commit or roll back together, so the series has
 * no gap. Nothing here calls the payment provider or sends mail; callers
 * raise alerts and send mail after the commit.
 */
import { gstSellerConfig, type GstSellerConfig } from '@/configs/billing.config'
import { GST_RATE_PERCENT, type GstState } from '@/constants/gst.constants'
import type { TaxDocumentRecord, TenantTaxDetailsRecord } from '@/database/models/tax.model'
import { BillingRepository, type ProviderScope } from '@/repositories/billing.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
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
  placeOfSupply,
  splitInclusive,
  stateOf,
  supplyKind,
  type TaxAmounts,
} from '@/utilities/gst.utilities'

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
   * The workspace's name at issue: the buyer's name when it has no tax details.
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
 * left to credit; `no_row` means no billing row, or no invoice of this
 * workspace by that id.
 */
export type IssueCreditNoteResult =
  | { outcome: 'issued'; document: TaxDocumentRecord }
  | { outcome: 'exists' | 'over_credit'; remainingMinor: number }
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
 * Issue the tax invoice for a paid charge, or hold it when the buyer is an
 * SEZ unit. In one transaction: the billing row, then a re-check that the
 * payment has no invoice or hold, then the tax details (unlocked, frozen into
 * the snapshot), then the number in the issue date's financial year, the
 * insert and the audit entry.
 * @param tenantId - The workspace.
 * @param charge - The paid charge and the line it prints.
 * @param scope - The provider and mode the charge came from.
 * @param now - The issue time, which picks the financial year.
 * @returns What happened.
 * @throws {Error} When GST registration is off.
 */
export async function issueInvoice(
  tenantId: string,
  charge: ProviderCharge & { description: string },
  scope: ProviderScope,
  now: Date = new Date()
): Promise<IssueInvoiceResult> {
  const seller = requireSeller()
  return withTransaction(async (tx) => {
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
    if (tenant === undefined) throw new Error(`Workspace ${tenantId} has a billing row but no row`)
    const placeCode =
      details === undefined
        ? seller.stateCode
        : placeOfSupply({ gstin: details.gstin, stateCode: details.stateCode }, seller.stateCode)
    const supply = supplyKind(seller.stateCode, placeCode)
    const amounts = splitInclusive(charge.amountMinor, supply)
    const snapshot = buildSnapshot({
      seller,
      details,
      tenantName: tenant.name,
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

    const financialYear = financialYearOf(now)
    const n = await taxRepository.allocateNumber('invoice', financialYear, tx)
    const document = await taxRepository.insertDocument(
      {
        type: 'invoice',
        number: formatDocumentNumber(seller.invoicePrefix, financialYear, n),
        financialYear,
        issuedAt: now,
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
}

/**
 * Issue a credit note against one of a workspace's invoices, for a processed
 * refund or, with `options.staff`, by hand. In one transaction: the staff
 * actor's platform role (admin or above) when staff issue it, then the
 * billing row, the invoice row, a re-check that the refund has no note, the
 * amount already credited, then the number in the issue date's financial
 * year, the insert and the audit entry.
 *
 * The note keeps its invoice's seller, buyer, place of supply and supply,
 * and its amounts are the cumulative difference, so all notes together equal
 * the invoice. A note dated from 1 December after its invoice's financial
 * year gives no tax reduction (`noTaxReduction`).
 * @param tenantId - The workspace.
 * @param invoiceId - The invoice to credit; another workspace's reads as not found.
 * @param credit - The amount, the refund (null by staff) and the reason.
 * @param now - The issue time, which picks the financial year.
 * @param options - `staff.actor` when staff issue it by hand.
 * @param options.staff - The staff member issuing it.
 * @returns What happened.
 * @throws {HttpError} 404 when the staff actor is no longer a platform admin.
 * @throws {Error} When GST registration is off.
 */
export async function issueCreditNote(
  tenantId: string,
  invoiceId: string,
  credit: CreditNoteInput,
  now: Date = new Date(),
  options: { staff?: { actor: Actor } } = {}
): Promise<IssueCreditNoteResult> {
  const seller = requireSeller()
  const staff = options.staff
  return withTransaction(async (tx) => {
    if (staff !== undefined) await assertStillPlatformRole(staff.actor, 'admin', tx)
    const billing = await billingRepository.lockByTenantId(tenantId, tx)
    if (billing === undefined) return { outcome: 'no_row' }
    const invoice = await taxRepository.lockInvoice(invoiceId, tx)
    // Another workspace's document reads as unknown, whatever its type.
    if (invoice === undefined || invoice.tenantId !== tenantId) return { outcome: 'no_row' }
    if (invoice.type !== 'invoice') return { outcome: 'not_an_invoice' }

    const scope: ProviderScope = { kind: invoice.provider, mode: invoice.providerMode }
    const credited = await taxRepository.creditedBefore(invoice.id, tx)
    const remainingMinor = invoice.totalMinor - credited
    if (credit.refundId !== null) {
      const existing = await taxRepository.findCreditNoteByRefund(scope, credit.refundId, tx)
      if (existing !== undefined) return { outcome: 'exists', remainingMinor }
    }
    if (credit.amountMinor > remainingMinor) return { outcome: 'over_credit', remainingMinor }

    const amounts = creditNoteAmounts(
      {
        totalMinor: invoice.totalMinor,
        taxableMinor: invoice.taxableMinor,
        cgstMinor: invoice.cgstMinor,
        sgstMinor: invoice.sgstMinor,
        igstMinor: invoice.igstMinor,
        ratePercent: GST_RATE_PERCENT,
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

    const financialYear = financialYearOf(now)
    const n = await taxRepository.allocateNumber('credit_note', financialYear, tx)
    const document = await taxRepository.insertDocument(
      {
        type: 'credit_note',
        number: formatDocumentNumber(seller.creditNotePrefix, financialYear, n),
        financialYear,
        issuedAt: now,
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
        noTaxReduction: isLateCreditNote(invoice.financialYear, now),
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
}
