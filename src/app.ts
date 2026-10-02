/**
 * @file The Express application, built without listening, workers or other
 * side effects, so tests can import it; server.ts owns the socket.
 */
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { corsOptions } from '@/configs/cors.config'
import { getEnv, trustProxySetting } from '@/configs/env.config'
import { helmetOptions } from '@/configs/helmet.config'
import { HttpError } from '@/errors/http-error'
import { errorHandler } from '@/middlewares/error.middleware'
import { posthogSession } from '@/middlewares/posthog-session.middleware'
import { requestContext } from '@/middlewares/request-context.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { createEmailWebhookRouter } from '@/routes/email-webhook.routes'
import { createApiRouter } from '@/routes/index.routes'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { isDatabaseReachable } from '@/services/database.service'
import { isShuttingDown } from '@/services/lifecycle.service'
import { registerOnboardingSubscribers } from '@/services/onboarding.service'
import { isQueueReachable } from '@/services/queue.service'
import { isRedisReachable } from '@/services/redis.service'

/**
 * Build the Express application.
 *
 * `trust proxy` comes from TRUST_PROXY because it decides what `request.ip`,
 * and so every IP-keyed rate limiter, sees: off behind a proxy, every client
 * shares one bucket; on where no proxy strips X-Forwarded-For, each request
 * can name its own IP and escape the limiters. A malformed value throws here,
 * at boot. `/health` stays shallow so a database blip never restarts a
 * healthy process; `/health/ready` checks every dependency, since failing it
 * only removes the pod from rotation. It also registers the domain-event
 * subscribers (`registerOnboardingSubscribers`, `registerAnalyticsSubscribers`),
 * which is idempotent.
 * @returns A configured app with no listening socket.
 */
export function createApp(): Express {
  // Here, not in index.ts, so every test that builds the app has the subscribers too.
  registerOnboardingSubscribers()
  registerAnalyticsSubscribers()

  const app = express()

  app.disable('x-powered-by')

  app.set('trust proxy', trustProxySetting(getEnv().TRUST_PROXY))

  // Security: first, so every response, including preflights, 404s and errors, gets the headers.
  app.use(helmet(helmetOptions))

  // Before requestId and the body parsers: an allowed preflight ends here; a disallowed one gets no grant header.
  app.use(cors(corsOptions))

  app.use(requestId)
  app.use(requestContext)
  app.use(posthogSession)
  // Before the body parsers: a webhook signature covers the exact bytes, which express.json would consume.
  app.use('/api/v1/webhooks/email', createEmailWebhookRouter())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '100kb' }))

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', uptime: process.uptime() })
  })

  app.get('/health/ready', async (_request, response) => {
    // A draining pod leaves rotation before its dependencies close.
    if (isShuttingDown()) {
      response.status(503).json({ status: 'shutting-down' })
      return
    }
    const [database, redis, queue] = await Promise.all([
      isDatabaseReachable(),
      isRedisReachable(),
      isQueueReachable(),
    ])
    const isReady = database && redis && queue
    response.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not-ready',
      checks: { database, redis, queue },
    })
  })

  app.use('/api/v1', createApiRouter())

  app.use((_request, _response, next) => {
    next(new HttpError('Not found', 404))
  })
  app.use(errorHandler)

  return app
}
