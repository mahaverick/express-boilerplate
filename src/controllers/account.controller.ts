/**
 * @file Handlers for `/api/v1/account`, behind `requireAuth`: a customer's
 * request to delete their account, and reading the open one back.
 */
import { BaseController } from '@/controllers/base.controller'
import { authenticatedUserId } from '@/controllers/helpers.controller'
import type { AccountDeletionRequest } from '@/database/models/account-deletion-request.model'
import {
  findOpenDeletionRequest,
  requestAccountDeletion,
} from '@/services/account-deletion.service'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { successResponse } from '@/utilities/response.utilities'
import { accountDeletionRequestBody } from '@/validators/account.validators'
import { parseBody } from '@/validators/parse.validators'

/**
 * A deletion request as a client reads it: when it was made and when we
 * will have deleted the account by, as ISO 8601 UTC.
 */
interface DeletionRequestView {
  requestedAt: string
  dueAt: string
}

/**
 * The wire shape of a request: its times only, never the reason or the row id.
 * @param request - The row.
 * @returns The view.
 */
function toDeletionRequestView(request: AccountDeletionRequest): DeletionRequestView {
  return { requestedAt: request.requestedAt.toISOString(), dueAt: request.dueAt.toISOString() }
}

/**
 * Handlers for `/api/v1/account`.
 */
class AccountController extends BaseController {
  /**
   * `POST /account/deletion-request`: open a request, 201, or return the
   * one already open, 200. The 201 says the receipt is on its way: it is
   * queued after commit, and a failed enqueue is only logged. The 200 says
   * it went with the first request, since this call sends nothing.
   */
  requestDeletion = this.handle(async (request, response) => {
    const { reason } = parseBody(accountDeletionRequestBody, request.body)
    const { request: opened, created } = await requestAccountDeletion(
      authenticatedUserId(request),
      reason === undefined || reason === '' ? null : reason
    )
    successResponse(
      response,
      toDeletionRequestView(opened),
      `We'll delete your account by ${formatUtcDateTime(opened.dueAt)}. ${created ? 'We are emailing you a receipt.' : 'We emailed you a receipt when you asked.'}`,
      created ? 201 : 200
    )
  })

  /**
   * `GET /account/deletion-request`: the open request, or null.
   */
  getDeletionRequest = this.handle(async (request, response) => {
    const open = await findOpenDeletionRequest(authenticatedUserId(request))
    successResponse(
      response,
      { request: open ? toDeletionRequestView(open) : null },
      open ? 'Deletion request retrieved.' : 'No deletion request is open.'
    )
  })
}

/**
 * The account controller the account routes mount.
 */
export const accountController = new AccountController()
