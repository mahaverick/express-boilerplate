/**
 * @file The Razorpay webhook, mounted by app.ts at
 * `/api/v1/webhooks/razorpay` ahead of the global `express.json`, so the
 * handler sees the exact bytes Razorpay signed. Public: no bearer token, no
 * JSON content-type gate; the signature authenticates the request. The
 * provider gate runs first, then the per-IP limiter on rejected requests and
 * the per-IP limiter on accepted ones, all before the body is read.
 */
import express, { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { billingWebhookController } from '@/controllers/billing-webhook.controller'
import { requireEnabledBillingWebhook } from '@/middlewares/billing-webhook.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * The largest webhook body read. A Razorpay event is a few kilobytes; the
 * global JSON parser's 1mb never applies to this route.
 */
const BILLING_WEBHOOK_BODY_LIMIT = '256kb'

/**
 * Build the Razorpay webhook route.
 * @returns A router mounted at `/api/v1/webhooks/razorpay` by app.ts.
 */
export function createBillingWebhookRouter(): Router {
  const router = Router()
  router.post(
    '/',
    requireEnabledBillingWebhook,
    createRateLimiter(RATE_LIMITS.billingWebhookRejected),
    createRateLimiter(RATE_LIMITS.billingWebhook),
    express.raw({ type: '*/*', limit: BILLING_WEBHOOK_BODY_LIMIT }),
    billingWebhookController.receive
  )
  return router
}
