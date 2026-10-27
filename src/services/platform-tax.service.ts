/**
 * @file Staff tax routes for one customer workspace, behind
 * `/api/v1/platform/tenants/:id/billing`: the tax details read and the
 * manager's save, the document list and PDFs, the admin's manual credit
 * note, and the held SEZ charges with their resolve. The platform tenant
 * answers `tenant_billing_not_found` first, as every staff billing route
 * does. Reads share the staff billing read's throttled `billing.viewed`
 * audit window, a PDF download included.
 *
 * Registration gates follow the owner routes: reads answer while
 * registration is on or the workspace has documents, writes only while it
 * is on. The held-charge routes also answer for a workspace that has held
 * charges, and the resolve stays open while registration is off, since it
 * only records work staff did by hand.
 *
 * Each write re-checks the staff role under lock: the tax details save in
 * `saveTaxDetails`, the manual credit note in `issueCreditNote`'s one
 * transaction (the platform role, then the billing row, the invoice row and
 * the counter), and the resolve in its own.
 */
import { gstSellerConfig } from '@/configs/billing.config'
import {
  CREDIT_EXCEEDS_INVOICE_CODE,
  CREDIT_NOTE_REPEATED_CODE,
  creditExceedsInvoiceMessage,
  creditNoteIssuedMessage,
  creditNoteRepeatedMessage,
  HELD_CHARGE_RESOLVED_CODE,
  heldChargeResolvedMessage,
  NOT_AN_INVOICE_CODE,
  NOT_AN_INVOICE_MESSAGE,
  staffTaxDetailsSavedMessage,
} from '@/constants/billing.constants'
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import type { Tenant } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { nameOrEmail } from '@/presenters/billing.presenter'
import {
  presentHeldCharge,
  presentStaffTaxDocument,
  presentTaxDetails,
  type StaffTaxDetailsView,
  type StaffTaxDocumentItem,
  type TaxHeldChargeView,
} from '@/presenters/tax.presenter'
import {
  heldChargeList,
  PlatformTaxRepository,
  staffTaxDocumentList,
} from '@/repositories/platform-tax.repository'
import { TaxRepository, type TaxDocumentReferences } from '@/repositories/tax.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { sendTaxDocumentIssued } from '@/services/billing/billing-emails.service'
import {
  assertTaxReadable,
  assertTaxWritable,
  saveTaxDetails,
} from '@/services/billing/tax-details.service'
import { getDocumentPdf, issueCreditNote } from '@/services/billing/tax-documents.service'
import { raiseLateCreditNoteAlert } from '@/services/billing/tax-reconcile.service'
import { db, withTransaction } from '@/services/database.service'
import { auditBillingView, customerTenant } from '@/services/platform-billing.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import type { Actor } from '@/types/actor'
import { formatDateInZone } from '@/utilities/date-text.utilities'
import { istTime } from '@/utilities/gst.utilities'
import { listPage, type ListPage } from '@/utilities/list-page.utilities'
import { formatRupees } from '@/utilities/money-text.utilities'
import type {
  HeldChargeListQuery,
  ManualCreditNoteBody,
  StaffTaxDocumentListQuery,
  TaxDetailsPatch,
} from '@/validators/tax.validators'

const platformTaxRepository = new PlatformTaxRepository()
const taxRepository = new TaxRepository()
const userRepository = new UserRepository()

/**
 * A user's id and name (or email), soft-deleted accounts included.
 * @param userId - The user, or null.
 * @returns The person, or null when there is none or the account is gone.
 */
async function personOf(userId: string | null): Promise<{ userId: string; name: string } | null> {
  if (userId === null) return null
  const [user] = await userRepository.findManyByIds([userId], { includeDeleted: true })
  return user === undefined ? null : { userId: user.id, name: nameOrEmail(user) }
}

/**
 * Refuse a held-charge route while registration is off, unless the
 * workspace has documents or held charges.
 * @param tenantId - The workspace.
 * @throws {HttpError} 404 `tax_documents_disabled` with the read message.
 */
async function assertHeldReadable(tenantId: string): Promise<void> {
  if (gstSellerConfig() !== null || (await platformTaxRepository.hasHeld(tenantId))) return
  await assertTaxReadable(tenantId)
}

/**
 * A customer workspace's tax details as staff read them, audited as a
 * billing read.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The workspace.
 * @returns The details with who saved them last, or null before the first save.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant; 404 `tax_documents_disabled` while registration is off and the workspace has no documents.
 */
export async function getStaffTaxDetails(
  actor: Actor,
  tenantId: string
): Promise<StaffTaxDetailsView | null> {
  await customerTenant(tenantId)
  await assertTaxReadable(tenantId)
  const row = await taxRepository.findDetails(tenantId)
  const view =
    row === undefined
      ? null
      : { ...presentTaxDetails(row), updatedBy: await personOf(row.updatedBy) }
  await auditBillingView(actor, tenantId)
  return view
}

/**
 * Refuse a staff tax write before its body is read: the workspace's 404s,
 * then registration's. The write's service takes the workspace this returns
 * and doesn't read it again.
 * @param tenantId - The workspace.
 * @returns The workspace.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant; 404 `tax_documents_disabled` while registration is off.
 */
export async function assertStaffTaxWritable(tenantId: string): Promise<Tenant> {
  const tenant = await customerTenant(tenantId)
  assertTaxWritable()
  return tenant
}

/**
 * Refuse a held-charge resolve before its body is read: the workspace's
 * 404s, then registration's. The resolve stays open while registration is
 * off for a workspace with documents or held charges, since it only records
 * work staff did by hand.
 * @param tenantId - The workspace.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant; 404 `tax_documents_disabled` while registration is off and the workspace has no documents or held charges.
 */
export async function assertStaffHeldWritable(tenantId: string): Promise<void> {
  await customerTenant(tenantId)
  await assertHeldReadable(tenantId)
}

/**
 * Save a customer workspace's tax details as staff, under the owner's rules,
 * audited with platform access, the changed field names and the reason.
 * Call `assertStaffTaxWritable` first.
 * @param actor - The staff member (a platform manager or above; re-checked under lock).
 * @param tenant - The workspace `assertStaffTaxWritable` returned.
 * @param body - The validated PATCH body with the reason.
 * @returns The saved details, and the success message naming the workspace.
 * @throws {HttpError} As `saveTaxDetails`.
 */
export async function saveStaffTaxDetails(
  actor: Actor,
  tenant: Tenant,
  body: TaxDetailsPatch & { reason: string }
): Promise<{ details: StaffTaxDetailsView; message: string }> {
  const { reason, ...patch } = body
  const saved = await saveTaxDetails(actor, tenant.id, patch, { access: 'platform', reason })
  return {
    details: { ...saved, updatedBy: await personOf(actor.userId) },
    message: staffTaxDetailsSavedMessage(tenant.name),
  }
}

/**
 * Present documents for staff with their links and who issued the manual
 * notes.
 * @param documents - The rows.
 * @param creators - Who issued each manual note, by document id.
 * @returns The items.
 */
async function staffItems(
  documents: readonly TaxDocumentRecord[],
  creators: ReadonlyMap<string, { userId: string; name: string } | null>
): Promise<StaffTaxDocumentItem[]> {
  const references = await taxRepository.listRefsFor(documents)
  return documents.map((document) =>
    presentStaffTaxDocument(document, references, creators.get(document.id) ?? null)
  )
}

/**
 * One page of a customer workspace's tax documents for staff, newest first by
 * default, with search on the number, audited as a billing read.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The workspace.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} The workspace's 404s; 404 `tax_documents_disabled` while registration is off and the workspace has no documents.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listStaffTaxDocuments(
  actor: Actor,
  tenantId: string,
  query: StaffTaxDocumentListQuery
): Promise<ListPage<StaffTaxDocumentItem>> {
  await customerTenant(tenantId)
  await assertTaxReadable(tenantId)
  const page = await listPage(
    db,
    staffTaxDocumentList(tenantId, query.params.search, { types: query.filters.type }),
    query.params
  )
  const items = await staffItems(
    page.items.map((row) => row.document),
    new Map(page.items.map((row) => [row.document.id, row.createdBy]))
  )
  await auditBillingView(actor, tenantId)
  return { ...page, items }
}

/**
 * One of a customer workspace's tax documents as a PDF for staff, audited as
 * a billing read once the bytes are built.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The workspace.
 * @param documentId - The document.
 * @returns The file name and the bytes.
 * @throws {HttpError} The workspace's 404s; as `getDocumentPdf`.
 */
export async function getStaffDocumentPdf(
  actor: Actor,
  tenantId: string,
  documentId: string
): Promise<{ filename: string; body: Buffer }> {
  await customerTenant(tenantId)
  const pdf = await getDocumentPdf(tenantId, documentId, actor, 'apex')
  await auditBillingView(actor, tenantId)
  return { filename: pdf.filename, body: pdf.body }
}

/**
 * Issue a credit note by hand against one of a customer workspace's
 * invoices (for a lost dispute). `issueCreditNote` re-checks the admin role,
 * locks the billing row, the invoice and the counter in one transaction, and
 * records `billing.credit_note_issued_by_staff`. The reason is printed on the
 * credit note the customer downloads. A late note raises its alert after the
 * commit. The answer is built from what is in hand before and at the commit,
 * with no read after it, so a committed note never answers a 500 that
 * invites a second submit. Call `assertStaffTaxWritable` first.
 * @param actor - The staff member (a platform admin or above; re-checked under lock).
 * @param tenantId - The workspace.
 * @param documentId - The invoice.
 * @param body - The amount in paise and the reason the note prints.
 * @returns The new note and the success message.
 * @throws {HttpError} 404 `tax_document_not_found`; 409 `NOT_AN_INVOICE`; 409 `CREDIT_NOTE_REPEATED` when the same staff member issued this amount and reason against it in the last 10 minutes; 409 `CREDIT_EXCEEDS_INVOICE` with `details.remainingMinor`; the unknown-route 404 when the actor is no longer an admin.
 */
export async function issueManualCreditNote(
  actor: Actor,
  tenantId: string,
  documentId: string,
  body: ManualCreditNoteBody
): Promise<{ document: StaffTaxDocumentItem; message: string }> {
  const creator = await personOf(actor.userId)
  const result = await issueCreditNote(
    tenantId,
    documentId,
    { amountMinor: body.amountMinor, refundId: null, reason: body.reason },
    undefined,
    { staff: { actor } }
  )
  switch (result.outcome) {
    case 'issued': {
      const { document } = result
      await raiseLateCreditNoteAlert(tenantId, document)
      await sendTaxDocumentIssued(document)
      return {
        document: presentStaffTaxDocument(document, newNoteReferences(document), creator),
        message: creditNoteIssuedMessage(document.number, formatRupees(document.totalMinor)),
      }
    }
    case 'repeated': {
      const { document } = result
      throw new HttpError(
        creditNoteRepeatedMessage(document.number, istTime(document.issuedAt)),
        409,
        CREDIT_NOTE_REPEATED_CODE
      )
    }
    case 'over_credit': {
      throw new HttpError(
        creditExceedsInvoiceMessage(formatRupees(result.remainingMinor)),
        409,
        CREDIT_EXCEEDS_INVOICE_CODE,
        undefined,
        { details: { remainingMinor: result.remainingMinor } }
      )
    }
    case 'not_an_invoice': {
      throw new HttpError(NOT_AN_INVOICE_MESSAGE, 409, NOT_AN_INVOICE_CODE)
    }
    case 'no_row': {
      throw notFoundError('taxDocument')
    }
    case 'exists': {
      throw new Error('A staff credit note has no refund, so it cannot already exist')
    }
  }
}

/**
 * The links a credit note just issued shows, from the row alone: the
 * invoice it reduces, by the number its snapshot froze.
 * @param note - The committed credit note.
 * @returns The references `presentStaffTaxDocument` reads.
 */
function newNoteReferences(note: TaxDocumentRecord): TaxDocumentReferences {
  const references: TaxDocumentReferences = {
    creditNotes: new Map(),
    credited: new Map(),
    originals: new Map(),
  }
  const original = note.snapshot.original
  if (note.originalDocumentId !== null && original !== null) {
    references.originals.set(note.id, { id: note.originalDocumentId, number: original.number })
  }
  return references
}

/**
 * One page of a customer workspace's held SEZ charges, newest held first,
 * audited as a billing read.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The workspace.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} The workspace's 404s; 404 `tax_documents_disabled` while registration is off and the workspace has no documents or held charges.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listHeldCharges(
  actor: Actor,
  tenantId: string,
  query: HeldChargeListQuery
): Promise<ListPage<TaxHeldChargeView>> {
  await customerTenant(tenantId)
  await assertHeldReadable(tenantId)
  const page = await listPage(db, heldChargeList(tenantId, query.filters.status), query.params)
  await auditBillingView(actor, tenantId)
  return {
    ...page,
    items: page.items.map((row) => presentHeldCharge(row.charge, row.resolvedBy)),
  }
}

/**
 * The 409 for a held charge already resolved, naming the IST day it was.
 * @param resolvedAt - When it was resolved.
 * @returns The error.
 */
function alreadyResolved(resolvedAt: Date): HttpError {
  return new HttpError(
    heldChargeResolvedMessage(formatDateInZone(resolvedAt, 'Asia/Kolkata')),
    409,
    HELD_CHARGE_RESOLVED_CODE
  )
}

/**
 * Record that staff issued a held SEZ charge's invoice by hand: sets when,
 * who and the note, and audits `billing.held_charge_resolved`, in one
 * transaction after the admin role's re-check. Issues nothing. Call
 * `assertStaffHeldWritable` first.
 *
 * Lock order: the platform role (`assertStillPlatformRole`), then the held
 * row, which the conditional update locks; two resolves queue there and the
 * second finds it resolved.
 * @param actor - The staff member (a platform admin or above; re-checked under lock).
 * @param tenantId - The workspace.
 * @param heldId - The held charge.
 * @param reason - The staff member's note, stored as the resolution.
 * @returns The resolved charge.
 * @throws {HttpError} 404 `tax_held_charge_not_found`, also when the row is gone by the update; 409 `HELD_CHARGE_RESOLVED`; the unknown-route 404 when the actor is no longer an admin.
 */
export async function resolveHeldCharge(
  actor: Actor,
  tenantId: string,
  heldId: string,
  reason: string
): Promise<TaxHeldChargeView> {
  const resolved = await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const existing = await platformTaxRepository.findHeld(tenantId, heldId, tx)
    if (existing === undefined) throw notFoundError('taxHeldCharge')
    if (existing.charge.resolvedAt !== null) throw alreadyResolved(existing.charge.resolvedAt)
    const updated = await platformTaxRepository.resolveHeld(
      tenantId,
      heldId,
      actor.userId,
      reason,
      tx
    )
    // Another resolve committed between the read and the update, or the row is gone.
    if (updated === undefined) {
      const raced = await platformTaxRepository.findHeld(tenantId, heldId, tx)
      const resolvedAt = raced?.charge.resolvedAt
      if (resolvedAt === undefined || resolvedAt === null) throw notFoundError('taxHeldCharge')
      throw alreadyResolved(resolvedAt)
    }
    await record(
      {
        action: 'billing.held_charge_resolved',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { heldChargeId: heldId, reason },
      },
      tx
    )
    return updated
  })
  return presentHeldCharge(resolved, await personOf(actor.userId))
}
