/**
 * @file The Razorpay webhook handler. It hands the raw body `express.raw`
 * read, byte for byte, to `receiveRazorpayWebhook`: the signature covers the
 * exact bytes Razorpay sent.
 */
import { BaseController } from '@/controllers/base.controller'
import { receiveRazorpayWebhook } from '@/services/billing/billing-webhook.service'
import { successResponse } from '@/utilities/response.utilities'

/**
 * Handlers for `/api/v1/webhooks/razorpay`.
 */
class BillingWebhookController extends BaseController {
  /**
   * `POST /webhooks/razorpay`: verify, record and queue one delivery.
   * Public: Razorpay's signature is the authentication. A body without a
   * Content-Type is left unparsed by `express.raw`, and verifies as empty.
   */
  receive = this.handle(async (request, response) => {
    const body: unknown = request.body
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
    const result = await receiveRazorpayWebhook(rawBody, request.headers)
    successResponse(response, { result }, 'Webhook received.')
  })
}

/**
 * The controller the Razorpay webhook route mounts.
 */
export const billingWebhookController = new BillingWebhookController()
