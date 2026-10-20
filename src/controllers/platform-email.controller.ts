/**
 * @file Handlers for `/api/v1/platform/emails` and
 * `/api/v1/platform/email-suppressions`. Every route runs behind
 * `requireAuth` and `requirePlatformRole` (platform-email.routes.ts).
 */
import { BaseController } from '@/controllers/base.controller'
import { actorFrom } from '@/controllers/helpers.controller'
import {
  getEmailDetail,
  getEmailHealth,
  liftSuppression,
  listEmails,
  listSuppressions,
  previewEmail,
  resendEmail,
} from '@/services/platform-email.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  emailHealthQuerySchema,
  platformEmailListSchema,
  platformSuppressionListSchema,
} from '@/validators/platform-email.validators'
import { parseIdParameter, reasonBodySchema } from '@/validators/platform.validators'

/**
 * Handlers for the staff email routes.
 */
class PlatformEmailController extends BaseController {
  /**
   * `GET /platform/emails`: one page of messages, searchable by recipient, sortable and filterable.
   */
  searchEmails = this.handle(async (request, response) => {
    const query = parseBody(platformEmailListSchema, request.query)
    successResponse(response, await listEmails(actorFrom(request), query), 'Emails retrieved.')
  })

  /**
   * `GET /platform/emails/health`: deliverability over a range.
   */
  getEmailHealth = this.handle(async (request, response) => {
    const { range } = parseBody(emailHealthQuerySchema, request.query)
    successResponse(response, await getEmailHealth(range), 'Email health retrieved.')
  })

  /**
   * `GET /platform/emails/:id`: one message's timeline.
   */
  getEmail = this.handle(async (request, response) => {
    const id = parseIdParameter(request.params.id, 'email')
    successResponse(response, await getEmailDetail(actorFrom(request), id), 'Email retrieved.')
  })

  /**
   * `GET /platform/emails/:id/preview`: the stored template re-rendered, with link tokens masked.
   */
  previewEmail = this.handle(async (request, response) => {
    const id = parseIdParameter(request.params.id, 'email')
    successResponse(response, await previewEmail(id), 'Email preview rendered.')
  })

  /**
   * `POST /platform/emails/:id/resend`: run the action that sent it again. 202: the mail is queued, not sent.
   */
  resendEmail = this.handle(async (request, response) => {
    const id = parseIdParameter(request.params.id, 'email')
    const { reason } = parseBody(reasonBodySchema, request.body)
    const result = await resendEmail(actorFrom(request), id, reason, request.authTime)
    successResponse(response, result, 'Resend requested.', 202)
  })

  /**
   * `GET /platform/email-suppressions`: one page of suppressions, searchable by address, sortable and filterable by state.
   */
  searchSuppressions = this.handle(async (request, response) => {
    const query = parseBody(platformSuppressionListSchema, request.query)
    successResponse(response, await listSuppressions(query), 'Suppressions retrieved.')
  })

  /**
   * `POST /platform/email-suppressions/:id/lift`: let mail reach the address again.
   */
  liftSuppression = this.handle(async (request, response) => {
    const id = parseIdParameter(request.params.id, 'suppression')
    const { reason } = parseBody(reasonBodySchema, request.body)
    successResponse(
      response,
      await liftSuppression(actorFrom(request), id, reason),
      'Suppression lifted.'
    )
  })
}

/**
 * The controller the platform email routes mount.
 */
export const platformEmailController = new PlatformEmailController()
