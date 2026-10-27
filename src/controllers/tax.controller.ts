/**
 * @file Handlers for a workspace owner's tax details: the read and the
 * PATCH of the changed fields. Registration's gate runs first, so a write
 * while it is off answers its 404 before any field is checked.
 */
import { TAX_DETAILS_SAVED_MESSAGE } from '@/constants/billing.constants'
import { BaseController } from '@/controllers/base.controller'
import { actorFrom, tenantPrincipal } from '@/controllers/helpers.controller'
import {
  assertTaxReadable,
  assertTaxWritable,
  getTaxDetails,
  saveTaxDetails,
} from '@/services/billing/tax-details.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import { taxDetailsPatchSchema } from '@/validators/tax.validators'

/**
 * Tax handlers for the owner routes under `/tenants/:slug/billing`.
 */
class TaxController extends BaseController {
  /**
   * `GET /tenants/:slug/billing/tax-details`: the details, or null before the first save.
   */
  getTaxDetails = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    await assertTaxReadable(tenantId)
    successResponse(response, await getTaxDetails(tenantId))
  })

  /**
   * `PATCH /tenants/:slug/billing/tax-details`: save the changed fields.
   */
  saveTaxDetails = this.handle(async (request, response) => {
    const { tenantId } = tenantPrincipal(request)
    assertTaxWritable()
    const patch = parseBody(taxDetailsPatchSchema, request.body)
    const saved = await saveTaxDetails(actorFrom(request), tenantId, patch, {
      access: 'member',
      reason: null,
    })
    successResponse(response, saved, TAX_DETAILS_SAVED_MESSAGE)
  })
}

/**
 * The tax controller instance the routes mount.
 */
export const taxController = new TaxController()
