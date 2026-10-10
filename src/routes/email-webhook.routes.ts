/**
 * @file Provider webhooks for email delivery events, mounted by app.ts at
 * `/api/v1/webhooks/email` ahead of the global `express.json`, so the
 * handler sees the exact bytes the provider signed. Public: no bearer token,
 * no JSON content-type gate; the signature authenticates the request. The
 * provider gate runs first, then the per-IP limiter on rejected requests and
 * the per-provider limiter on accepted ones, all before the body is read.
 */
import express, { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { emailWebhookController } from '@/controllers/email-webhook.controller'
import { requireEnabledEmailWebhookProvider } from '@/middlewares/email-webhook.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * The largest webhook body read. A provider event is a few kilobytes; the
 * global JSON parser's 1mb never applies to this route.
 */
const EMAIL_WEBHOOK_BODY_LIMIT = '256kb'

/**
 * Build the email webhook routes.
 * @returns A router mounted at `/api/v1/webhooks/email` by app.ts.
 */
export function createEmailWebhookRouter(): Router {
  const router = Router()
  router.post(
    '/:provider',
    requireEnabledEmailWebhookProvider,
    createRateLimiter(RATE_LIMITS.emailWebhookRejected),
    createRateLimiter(RATE_LIMITS.emailWebhook),
    express.raw({ type: '*/*', limit: EMAIL_WEBHOOK_BODY_LIMIT }),
    emailWebhookController.receive
  )
  return router
}
