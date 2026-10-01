/**
 * @file The provider gate must run before the limiter, and the limiter
 * before the body is read: a limiter first would put RateLimit-* headers on
 * an unknown provider's 404 and key buckets by arbitrary path text.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { emailWebhookController } from '@/controllers/email-webhook.controller'
import { requireEnabledEmailWebhookProvider } from '@/middlewares/email-webhook.middleware'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createEmailWebhookRouter } from '@/routes/email-webhook.routes'

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  const layers = router.stack as unknown as RouteLayer[]
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

describe('createEmailWebhookRouter', () => {
  it('runs the provider gate, the email-webhook limiter, the raw parser, then the handler', () => {
    const [gate, limiter, parser, handler, ...rest] = handlersFor(
      createEmailWebhookRouter(),
      'post',
      '/:provider'
    )

    expect(gate).toBe(requireEnabledEmailWebhookProvider)
    expect((limiter as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe('email-webhook')
    expect(parser?.name).toBe('rawParser')
    expect(handler).toBe(emailWebhookController.receive)
    expect(rest).toEqual([])
  })
})
