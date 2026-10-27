import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
/**
 * @file Query access to a workspace's tax details, the tax documents issued
 * to it, their gap-free number counters and its held SEZ charges. It does
 * not extend `BaseRepository`, which requires a `deletedAt` column these
 * tables have no use for: documents are never deleted, and a document's
 * `tenant_id` is nulled when its workspace is purged. Consumers create their
 * own instance at module scope.
 */
import type { TaxDocumentType } from '@/constants/gst.constants'
import {
  taxDocumentCounterModel,
  taxDocumentModel,
  taxHeldChargeModel,
  tenantTaxDetailsModel,
  type NewTaxDocument,
  type NewTaxHeldCharge,
  type NewTenantTaxDetails,
  type TaxDocumentRecord,
  type TaxHeldChargeRecord,
  type TenantTaxDetailsRecord,
} from '@/database/models/tax.model'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import type { ProviderScope } from '@/repositories/billing.repository'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import type { TaxDocumentReference } from '@/types/tax'
import { defineList, timestampKey, timestampSort } from '@/utilities/list-page.utilities'

/**
 * The columns a versioned details update may change: everything but the
 * key, the version and the update time, which the update sets itself.
 */
type TaxDetailsPatch = Partial<
  Omit<NewTenantTaxDetails, 'tenantId' | 'version' | 'updatedAt' | 'updatedBy'>
>

/**
 * The tax references a page of documents needs, built by `listRefsFor`.
 */
export interface TaxDocumentReferences {
  /**
   * The credit notes of each invoice on the page, oldest first, by invoice id.
   */
  creditNotes: Map<string, TaxDocumentReference[]>
  /**
   * The total credited against each invoice on the page, by invoice id.
   */
  credited: Map<string, number>
  /**
   * The invoice each credit note on the page reduces, by credit note id.
   */
  originals: Map<string, TaxDocumentReference>
}

/**
 * What the invoice rows of a billing page show of one payment's tax state.
 */
export interface InvoiceRowTax {
  taxDocument: TaxDocumentReference | null
  creditNotes: TaxDocumentReference[]
  held: boolean
}

/**
 * Whether a document is the one a payment was invoiced as.
 * @param scope - The provider and mode.
 * @returns The condition over `tax_documents`.
 */
function invoiceOfProvider(scope: ProviderScope) {
  return and(
    eq(taxDocumentModel.type, 'invoice'),
    eq(taxDocumentModel.provider, scope.kind),
    eq(taxDocumentModel.providerMode, scope.mode)
  )
}

/**
 * The workspace's own tax documents, newest first by default. Its cursors
 * are bound to the workspace.
 * @param tenantId - The workspace.
 * @param types - The document types to keep, or undefined for both.
 * @returns The list definition.
 */
export function ownerDocumentList(tenantId: string, types: TaxDocumentType[] | undefined) {
  const document = taxDocumentModel
  return defineList({
    name: 'tenant-tax-documents',
    base: (executor, seek) =>
      executor
        .select({ id: document.id, document, sortAt: timestampKey(document.issuedAt) })
        .from(document)
        .where(
          and(
            eq(document.tenantId, tenantId),
            types === undefined ? undefined : inArray(document.type, types),
            seek
          )
        )
        .$dynamic(),
    id: document.id,
    sorts: {
      '-issued': [timestampSort(document.issuedAt, 'desc', 'sortAt')],
      issued: [timestampSort(document.issuedAt, 'asc', 'sortAt')],
    },
    bound: { tenantId },
    toItem: (row): TaxDocumentRecord => row.document,
  })
}

/**
 * Query access to `tenant_tax_details`, `tax_documents`,
 * `tax_document_counters` and `tax_held_charges`.
 */
export class TaxRepository {
  /**
   * Find a workspace's tax details.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when never saved.
   */
  async findDetails(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<TenantTaxDetailsRecord | undefined> {
    const [row] = await executor
      .select()
      .from(tenantTaxDetailsModel)
      .where(eq(tenantTaxDetailsModel.tenantId, tenantId))
    return row
  }

  /**
   * Insert a workspace's first tax details.
   * @param row - The row's column values; `updatedBy` is the user who saved it.
   * @param tx - The open transaction.
   * @returns The inserted row.
   * @throws {HttpError} 409 `TAX_DETAILS_VERSION_CONFLICT`, when the workspace already has details.
   */
  async insertDetails(
    row: NewTenantTaxDetails & { updatedBy: string },
    tx: DbTransaction
  ): Promise<TenantTaxDetailsRecord> {
    try {
      const [created] = await tx.insert(tenantTaxDetailsModel).values(row).returning()
      if (created === undefined) throw new HttpError('Insert returned no row', 500)
      return created
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(
          'Someone changed these tax details since you opened them. Reload to see them, then save again.',
          409,
          'TAX_DETAILS_VERSION_CONFLICT'
        )
      }
      throw error
    }
  }

  /**
   * Change a workspace's tax details only if their version is still
   * `expectedVersion`. The update writes the given columns, adds one to
   * `version` and sets `updated_at`.
   * @param tenantId - The workspace.
   * @param expectedVersion - The version the caller read.
   * @param patch - The columns to change.
   * @param updatedBy - The user id saving the change.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when the version was stale.
   */
  async updateDetailsVersioned(
    tenantId: string,
    expectedVersion: number,
    patch: TaxDetailsPatch,
    updatedBy: string,
    tx: DbTransaction
  ): Promise<TenantTaxDetailsRecord | undefined> {
    const [row] = await tx
      .update(tenantTaxDetailsModel)
      .set({
        ...patch,
        updatedBy,
        version: sql`${tenantTaxDetailsModel.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tenantTaxDetailsModel.tenantId, tenantId),
          eq(tenantTaxDetailsModel.version, expectedVersion)
        )
      )
      .returning()
    return row
  }

  /**
   * Lock a workspace's tax details `FOR NO KEY UPDATE`, so a PATCH reads the
   * stored row under the lock it then writes under.
   *
   * Lock order: after `assertStillPlatformRole` for staff; it is the only
   * row the details write locks.
   * @param tenantId - The workspace.
   * @param tx - The open transaction.
   * @returns The locked row, or undefined when never saved.
   */
  async lockDetails(
    tenantId: string,
    tx: DbTransaction
  ): Promise<TenantTaxDetailsRecord | undefined> {
    const [row] = await tx
      .select()
      .from(tenantTaxDetailsModel)
      .where(eq(tenantTaxDetailsModel.tenantId, tenantId))
      .for('no key update')
    return row
  }

  /**
   * Lock an invoice's `tax_documents` row `FOR NO KEY UPDATE`, so credit
   * notes against it queue. The row is never deleted or re-keyed, and
   * `FOR UPDATE` would conflict with the `FOR KEY SHARE` a credit-note
   * insert's foreign key takes on it.
   *
   * Lock order: after the tenant billing row, before the number counter.
   * @param documentId - The invoice.
   * @param tx - The open transaction.
   * @returns The locked row, or undefined when none exists.
   */
  async lockInvoice(documentId: string, tx: DbTransaction): Promise<TaxDocumentRecord | undefined> {
    const [row] = await tx
      .select()
      .from(taxDocumentModel)
      .where(eq(taxDocumentModel.id, documentId))
      .for('no key update')
    return row
  }

  /**
   * Take the next number of a series. It creates the counter at 0 when the
   * series is new, locks it `FOR NO KEY UPDATE`, then bumps it, so two
   * allocators queue and a rollback leaves no gap.
   *
   * Lock order: last in the lock order; hold it for one insert. The counter
   * is shared by every workspace.
   * @param type - The document type.
   * @param financialYear - The series' financial year, such as `26-27`.
   * @param tx - The open transaction, which must also insert the document.
   * @returns The allocated number.
   */
  async allocateNumber(
    type: TaxDocumentType,
    financialYear: string,
    tx: DbTransaction
  ): Promise<number> {
    const counter = taxDocumentCounterModel
    await tx.insert(counter).values({ type, financialYear, lastNumber: 0 }).onConflictDoNothing()
    const [row] = await tx
      .select({ lastNumber: counter.lastNumber })
      .from(counter)
      .where(and(eq(counter.type, type), eq(counter.financialYear, financialYear)))
      .for('no key update')
    if (row === undefined) throw new HttpError('Number counter missing', 500)
    const next = row.lastNumber + 1
    await tx
      .update(counter)
      .set({ lastNumber: next })
      .where(and(eq(counter.type, type), eq(counter.financialYear, financialYear)))
    return next
  }

  /**
   * Insert a tax document.
   * @param row - The row's column values.
   * @param tx - The open transaction.
   * @returns The inserted row.
   */
  async insertDocument(row: NewTaxDocument, tx: DbTransaction): Promise<TaxDocumentRecord> {
    const [created] = await tx.insert(taxDocumentModel).values(row).returning()
    if (created === undefined) throw new HttpError('Insert returned no row', 500)
    return created
  }

  /**
   * Find the invoice issued for a payment.
   * @param scope - The provider and mode.
   * @param paymentId - The provider's payment id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The invoice, or undefined when none was issued.
   */
  async findInvoiceByPayment(
    scope: ProviderScope,
    paymentId: string,
    executor: DbExecutor = db
  ): Promise<TaxDocumentRecord | undefined> {
    const [row] = await executor
      .select()
      .from(taxDocumentModel)
      .where(and(invoiceOfProvider(scope), eq(taxDocumentModel.paymentId, paymentId)))
    return row
  }

  /**
   * Find the credit note issued for a refund.
   * @param scope - The provider and mode.
   * @param refundId - The provider's refund id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The credit note, or undefined when none was issued.
   */
  async findCreditNoteByRefund(
    scope: ProviderScope,
    refundId: string,
    executor: DbExecutor = db
  ): Promise<TaxDocumentRecord | undefined> {
    const [row] = await executor
      .select()
      .from(taxDocumentModel)
      .where(
        and(
          eq(taxDocumentModel.provider, scope.kind),
          eq(taxDocumentModel.providerMode, scope.mode),
          eq(taxDocumentModel.refundId, refundId)
        )
      )
    return row
  }

  /**
   * List the invoices issued for some payments, each with the sum of its
   * credit notes.
   * @param scope - The provider and mode.
   * @param paymentIds - The provider's payment ids.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The invoices with `creditedMinor`.
   */
  async listInvoicesByPayments(
    scope: ProviderScope,
    paymentIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Array<TaxDocumentRecord & { creditedMinor: number }>> {
    if (paymentIds.length === 0) return []
    const credits = executor
      .select({
        originalId: taxDocumentModel.originalDocumentId,
        total: sql<string | null>`sum(${taxDocumentModel.totalMinor})::bigint`.as('total'),
      })
      .from(taxDocumentModel)
      .where(isNotNull(taxDocumentModel.originalDocumentId))
      .groupBy(taxDocumentModel.originalDocumentId)
      .as('credits')
    const rows = await executor
      .select({ document: taxDocumentModel, credited: credits.total })
      .from(taxDocumentModel)
      .leftJoin(credits, eq(credits.originalId, taxDocumentModel.id))
      .where(and(invoiceOfProvider(scope), inArray(taxDocumentModel.paymentId, [...paymentIds])))
    return rows.map((row) => ({ ...row.document, creditedMinor: Number(row.credited ?? 0) }))
  }

  /**
   * The total already credited against an invoice, manual and automatic
   * notes alike. Call it after `lockInvoice`.
   * @param invoiceId - The invoice.
   * @param tx - The open transaction.
   * @returns The credited amount in paise.
   */
  async creditedBefore(invoiceId: string, tx: DbTransaction): Promise<number> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${taxDocumentModel.totalMinor}), 0)::bigint` })
      .from(taxDocumentModel)
      .where(eq(taxDocumentModel.originalDocumentId, invoiceId))
    return Number(row?.total ?? 0)
  }

  /**
   * Find the held charge of a payment.
   * @param scope - The provider and mode.
   * @param paymentId - The provider's payment id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The held charge, or undefined when the payment is not held.
   */
  async findHeldByPayment(
    scope: ProviderScope,
    paymentId: string,
    executor: DbExecutor = db
  ): Promise<TaxHeldChargeRecord | undefined> {
    const [row] = await executor
      .select()
      .from(taxHeldChargeModel)
      .where(
        and(
          eq(taxHeldChargeModel.provider, scope.kind),
          eq(taxHeldChargeModel.providerMode, scope.mode),
          eq(taxHeldChargeModel.paymentId, paymentId)
        )
      )
    return row
  }

  /**
   * Hold a charge, unless its payment is already held.
   * @param row - The row's column values.
   * @param tx - The open transaction.
   * @returns The new held charge, or undefined when the payment was already held.
   */
  async insertHeld(
    row: NewTaxHeldCharge,
    tx: DbTransaction
  ): Promise<TaxHeldChargeRecord | undefined> {
    const [created] = await tx
      .insert(taxHeldChargeModel)
      .values(row)
      .onConflictDoNothing()
      .returning()
    return created
  }

  /**
   * Find the workspace a payment was invoiced or held for.
   * @param scope - The provider and mode.
   * @param paymentId - The provider's payment id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The workspace id, or undefined when the payment is unknown or its workspace was purged.
   */
  async findTenantIdForPayment(
    scope: ProviderScope,
    paymentId: string,
    executor: DbExecutor = db
  ): Promise<string | undefined> {
    const invoice = await this.findInvoiceByPayment(scope, paymentId, executor)
    if (invoice?.tenantId != null) return invoice.tenantId
    const held = await this.findHeldByPayment(scope, paymentId, executor)
    return held?.tenantId
  }

  /**
   * Find one of a workspace's tax documents.
   * @param tenantId - The workspace.
   * @param id - The document id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The document, or undefined when unknown or another workspace's.
   */
  async findDocument(
    tenantId: string,
    id: string,
    executor: DbExecutor = db
  ): Promise<TaxDocumentRecord | undefined> {
    const [row] = await executor
      .select()
      .from(taxDocumentModel)
      .where(and(eq(taxDocumentModel.id, id), eq(taxDocumentModel.tenantId, tenantId)))
    return row
  }

  /**
   * Whether a workspace has any tax document.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when it has at least one.
   */
  async hasDocuments(tenantId: string, executor: DbExecutor = db): Promise<boolean> {
    const [row] = await executor
      .select({ id: taxDocumentModel.id })
      .from(taxDocumentModel)
      .where(eq(taxDocumentModel.tenantId, tenantId))
      .limit(1)
    return row !== undefined
  }

  /**
   * The references a page of documents shows, in one query: the credit
   * notes of the page's invoices (oldest first) and the invoices of the
   * page's credit notes.
   * @param documents - The page's documents.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Credit notes and credited totals by invoice id, and the original invoice by credit note id.
   */
  async listRefsFor(
    documents: readonly TaxDocumentRecord[],
    executor: DbExecutor = db
  ): Promise<TaxDocumentReferences> {
    const references: TaxDocumentReferences = {
      creditNotes: new Map(),
      credited: new Map(),
      originals: new Map(),
    }
    const invoiceIds = documents.filter((d) => d.type === 'invoice').map((d) => d.id)
    const originalIds = [
      ...new Set(
        documents.flatMap((d) =>
          d.type === 'credit_note' && d.originalDocumentId !== null ? [d.originalDocumentId] : []
        )
      ),
    ]
    for (const id of invoiceIds) {
      references.creditNotes.set(id, [])
      references.credited.set(id, 0)
    }
    if (invoiceIds.length === 0 && originalIds.length === 0) return references
    const document = taxDocumentModel
    const rows = await executor
      .select({
        id: document.id,
        type: document.type,
        number: document.number,
        originalDocumentId: document.originalDocumentId,
        totalMinor: document.totalMinor,
      })
      .from(document)
      .where(
        or(
          invoiceIds.length === 0 ? undefined : inArray(document.originalDocumentId, invoiceIds),
          originalIds.length === 0 ? undefined : inArray(document.id, originalIds)
        )
      )
      .orderBy(asc(document.issuedAt), asc(document.id))
    const invoiceReferences = new Map<string, TaxDocumentReference>()
    for (const row of rows) {
      if (row.type === 'invoice') {
        invoiceReferences.set(row.id, { id: row.id, number: row.number })
        continue
      }
      const notes =
        row.originalDocumentId === null
          ? undefined
          : references.creditNotes.get(row.originalDocumentId)
      if (row.originalDocumentId === null || notes === undefined) continue
      notes.push({ id: row.id, number: row.number })
      references.credited.set(
        row.originalDocumentId,
        (references.credited.get(row.originalDocumentId) ?? 0) + row.totalMinor
      )
    }
    for (const d of documents) {
      if (d.type !== 'credit_note' || d.originalDocumentId === null) continue
      const original = invoiceReferences.get(d.originalDocumentId)
      if (original !== undefined) references.originals.set(d.id, original)
    }
    return references
  }

  /**
   * What the invoice rows of one billing page show for their payments: the
   * tax invoice, its credit notes oldest first, and whether the payment is
   * held (an open or a resolved held charge exists, so no invoice follows).
   * @param tenantId - The workspace.
   * @param scope - The provider and mode.
   * @param paymentIds - The payments on the page.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The tax state by payment id; a payment with nothing is absent.
   */
  async listForInvoiceRows(
    tenantId: string,
    scope: ProviderScope,
    paymentIds: readonly string[],
    executor: DbExecutor = db
  ): Promise<Map<string, InvoiceRowTax>> {
    const result = new Map<string, InvoiceRowTax>()
    if (paymentIds.length === 0) return result
    const ids = [...paymentIds]
    const document = taxDocumentModel
    const invoices = await executor
      .select({ id: document.id, number: document.number, paymentId: document.paymentId })
      .from(document)
      .where(
        and(
          invoiceOfProvider(scope),
          eq(document.tenantId, tenantId),
          inArray(document.paymentId, ids)
        )
      )
    const byInvoice = new Map<string, InvoiceRowTax>()
    for (const invoice of invoices) {
      if (invoice.paymentId === null) continue
      const row: InvoiceRowTax = {
        taxDocument: { id: invoice.id, number: invoice.number },
        creditNotes: [],
        held: false,
      }
      result.set(invoice.paymentId, row)
      byInvoice.set(invoice.id, row)
    }
    if (byInvoice.size > 0) {
      const notes = await executor
        .select({
          id: document.id,
          number: document.number,
          originalDocumentId: document.originalDocumentId,
        })
        .from(document)
        .where(inArray(document.originalDocumentId, [...byInvoice.keys()]))
        .orderBy(asc(document.issuedAt), asc(document.id))
      for (const note of notes) {
        if (note.originalDocumentId === null) continue
        byInvoice
          .get(note.originalDocumentId)
          ?.creditNotes.push({ id: note.id, number: note.number })
      }
    }
    const held = await executor
      .select({ paymentId: taxHeldChargeModel.paymentId })
      .from(taxHeldChargeModel)
      .where(
        and(
          eq(taxHeldChargeModel.tenantId, tenantId),
          eq(taxHeldChargeModel.provider, scope.kind),
          eq(taxHeldChargeModel.providerMode, scope.mode),
          inArray(taxHeldChargeModel.paymentId, ids)
        )
      )
    for (const { paymentId } of held) {
      const row = result.get(paymentId)
      if (row === undefined) {
        result.set(paymentId, { taxDocument: null, creditNotes: [], held: true })
      } else {
        row.held = true
      }
    }
    return result
  }
}
