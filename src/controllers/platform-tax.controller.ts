/**
 * @file Handlers for the staff tax routes under
 * `/api/v1/platform/tenants/:id/billing`: tax details, tax documents and
 * their PDFs, the manual credit note, and held SEZ charges; and the
 * platform-wide GSTR-1 export at `/api/v1/platform/billing/tax-export`
 * (admin, with step-up). Every route runs
 * behind `requireAuth` and `requirePlatformRole` (platform-billing.routes.ts),
 * and every write behind `requireRecentAuth`. A write answers the
 * workspace's 404s and registration's before it reads the body.
 */
import { HELD_CHARGE_MARKED_RESOLVED_MESSAGE } from '@/constants/billing.constants'
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import { exportTaxPeriod } from '@/services/platform-tax-export.service'
import {
  assertStaffHeldWritable,
  assertStaffTaxReadable,
  assertStaffTaxWritable,
  getStaffDocumentPdf,
  getStaffTaxDetails,
  issueManualCreditNote,
  listHeldCharges,
  listStaffTaxDocuments,
  resolveHeldCharge,
  saveStaffTaxDetails,
} from '@/services/platform-tax.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { parseIdParameter, reasonBodySchema } from '@/validators/platform.validators'
import {
  heldChargeListSchema,
  manualCreditNoteBodySchema,
  staffTaxDetailsPatchSchema,
  staffTaxDocumentListSchema,
} from '@/validators/tax.validators'

/**
 * Handlers for one workspace's staff tax routes.
 */
class PlatformTaxController extends BaseController {
  /**
   * `GET /platform/tenants/:id/billing/tax-details`: the details, or null before the first save.
   */
  getTaxDetails = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    successResponse(
      response,
      await getStaffTaxDetails(actorFrom(request), tenantId),
      'Tax details retrieved.'
    )
  })

  /**
   * `PATCH /platform/tenants/:id/billing/tax-details`: save the changed fields, with a reason.
   */
  saveTaxDetails = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const tenant = await assertStaffTaxWritable(tenantId)
    const body = parseBody(staffTaxDetailsPatchSchema, request.body)
    const { details, message } = await saveStaffTaxDetails(actorFrom(request), tenant, body)
    successResponse(response, details, message)
  })

  /**
   * `GET /platform/tenants/:id/billing/tax-documents`: one page of the workspace's documents.
   */
  listTaxDocuments = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(staffTaxDocumentListSchema, request.query)
    successResponse(
      response,
      await listStaffTaxDocuments(actorFrom(request), tenantId, query),
      'Tax documents retrieved.'
    )
  })

  /**
   * `GET /platform/tenants/:id/billing/tax-documents/:docId/pdf`: the
   * document as a PDF download. Private and never cached, since it names
   * the buyer.
   */
  getTaxDocumentPdf = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    await assertStaffTaxReadable(tenantId)
    const documentId = parseIdParameter(request.params.docId, 'taxDocument')
    const pdf = await getStaffDocumentPdf(actorFrom(request), tenantId, documentId)
    response
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdf.filename}"`,
        'Cache-Control': 'private, no-store',
      })
      .send(pdf.body)
  })

  /**
   * `POST /platform/tenants/:id/billing/tax-documents/:docId/credit-notes`: issue a credit note by hand.
   */
  issueCreditNote = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    await assertStaffTaxWritable(tenantId)
    const body = parseBody(manualCreditNoteBodySchema, request.body)
    const documentId = parseIdParameter(request.params.docId, 'taxDocument')
    const { document, message } = await issueManualCreditNote(
      actorFrom(request),
      tenantId,
      documentId,
      body
    )
    successResponse(response, document, message)
  })

  /**
   * `GET /platform/tenants/:id/billing/tax-held-charges`: one page of the workspace's held SEZ charges.
   */
  listHeldCharges = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    const query = parseBody(heldChargeListSchema, request.query)
    successResponse(
      response,
      await listHeldCharges(actorFrom(request), tenantId, query),
      'Held charges retrieved.'
    )
  })

  /**
   * `POST /platform/tenants/:id/billing/tax-held-charges/:heldId/resolve`: record the charge as invoiced by hand.
   */
  resolveHeldCharge = this.handle(async (request, response) => {
    const tenantId = parseIdParameter(request.params.id, 'platformTenant')
    await assertStaffHeldWritable(tenantId)
    const { reason } = parseBody(reasonBodySchema, request.body)
    const heldId = parseIdParameter(request.params.heldId, 'taxHeldCharge')
    successResponse(
      response,
      await resolveHeldCharge(actorFrom(request), tenantId, heldId, reason),
      HELD_CHARGE_MARKED_RESOLVED_MESSAGE
    )
  })

  /**
   * `GET /platform/billing/tax-export?period=`: a month or quarter of tax
   * documents as a zip of GSTR-1 CSVs. Private and never cached, since it
   * names every buyer.
   */
  exportTaxDocuments = this.handle(async (request, response) => {
    const { period } = request.query
    const zip = await exportTaxPeriod(actorFrom(request), typeof period === 'string' ? period : '')
    response
      .status(200)
      .set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zip.filename}"`,
        'Cache-Control': 'private, no-store',
      })
      .send(Buffer.from(zip.body.buffer, zip.body.byteOffset, zip.body.byteLength))
  })
}

/**
 * The controller the staff tax routes mount.
 */
export const platformTaxController = new PlatformTaxController()
