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
  previewEmail,
  searchEmails,
  searchSuppressions,
} from '@/services/platform-email.service'
import { successResponse } from '@/utilities/response.utilities'
import { parseBody } from '@/validators/parse.validators'
import {
  emailHealthQuerySchema,
  platformEmailSearchSchema,
  platformSuppressionSearchSchema,
} from '@/validators/platform-email.validators'
import { parseIdParameter } from '@/validators/platform.validators'

/**
 * The 404 a malformed or unknown message id answers.
 */
const EMAIL_NOT_FOUND = 'Email not found'

/**
 * Handlers for the staff email routes.
 */
class PlatformEmailController extends BaseController {
  /**
   * `GET /platform/emails`: search messages, newest first.
   */
  searchEmails = this.handle(async (request, response) => {
    const query = parseBody(platformEmailSearchSchema, request.query)
    successResponse(response, await searchEmails(actorFrom(request), query), 'Emails retrieved.')
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
    const id = parseIdParameter(request.params.id, EMAIL_NOT_FOUND)
    successResponse(response, await getEmailDetail(actorFrom(request), id), 'Email retrieved.')
  })

  /**
   * `GET /platform/emails/:id/preview`: the stored template re-rendered, links masked.
   */
  previewEmail = this.handle(async (request, response) => {
    const id = parseIdParameter(request.params.id, EMAIL_NOT_FOUND)
    successResponse(response, await previewEmail(id), 'Email preview rendered.')
  })

  /**
   * `GET /platform/email-suppressions`: search suppressions, newest first.
   */
  searchSuppressions = this.handle(async (request, response) => {
    const query = parseBody(platformSuppressionSearchSchema, request.query)
    successResponse(response, await searchSuppressions(query), 'Suppressions retrieved.')
  })
}

/**
 * The controller the platform email routes mount.
 */
export const platformEmailController = new PlatformEmailController()
