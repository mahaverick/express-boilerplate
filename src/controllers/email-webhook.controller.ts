/**
 * @file The provider-facing email webhook handler. It hands the raw body
 * `express.raw` read, byte for byte, to `processEmailWebhook`: a signature
 * covers the exact bytes the provider sent.
 */
import { BaseController } from '@/controllers/base.controller'
import { HttpError } from '@/errors/http-error'
import { getEmailWebhookAdapter, processEmailWebhook } from '@/services/email-webhook.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * Handlers for `/api/v1/webhooks/email`.
 */
class EmailWebhookController extends BaseController {
  /**
   * `POST /webhooks/email/:provider`: verify and apply one provider request.
   * Public: the provider's signature is the authentication. A body without
   * a Content-Type is left unparsed by `express.raw`, and verifies as empty.
   */
  receive = this.handle(async (request, response) => {
    const { provider } = request.params
    const adapter = typeof provider === 'string' ? getEmailWebhookAdapter(provider) : undefined
    if (!adapter) throw new HttpError('Not found', 404)
    const body: unknown = request.body
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    const result = await processEmailWebhook(adapter, rawBody, request.headers)
    successResponse(response, result, 'Webhook processed.')
  })
}

/**
 * The controller the email webhook routes mount.
 */
export const emailWebhookController = new EmailWebhookController()
