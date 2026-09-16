// src/app.ts
//
// Builds the app and returns it. No listen, no workers, no side effects —
// that is what makes supertest able to import it, and it is why this is a
// separate file from server.ts. core's single 38k index.ts is the thing this
// split exists to avoid.
import express, { type Express } from 'express'
import { getEnv, trustProxySetting } from '@/configs/env.config'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'
import { requestContext } from '@/middlewares/request-context.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { createApiRouter } from '@/routes/index.routes'
import { isDatabaseReachable } from '@/services/database.service'
import { isQueueReachable } from '@/services/queue.service'
import { isRedisReachable } from '@/services/redis.service'

/**
 * Build the Express application.
 * @returns A configured app with no listening socket.
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')

  // WHO THE CLIENT IS. `request.ip` is the only thing the IP-keyed rate
  // limiters (rate-limit.middleware.ts) have to tell one caller from
  // another, and this one line decides whether it means the socket's peer or
  // whatever `X-Forwarded-For` claims. Both answers are wrong in the other
  // one's deployment, and both failures are silent:
  //
  //   - Left off behind a proxy, `request.ip` is the proxy for every
  //     request, so all four limiters share a single bucket across the whole
  //     deployment — 300 refreshes per 5 minutes for every user combined,
  //     not per client.
  //   - Turned on where it should not be, `X-Forwarded-For` is an ordinary
  //     request header a client writes itself, so every request can carry a
  //     different "client IP" and get its own fresh bucket. The login
  //     limiter simply stops applying.
  //
  // So it is configuration (`TRUST_PROXY`), not a literal: the value depends
  // on the deployment and nothing in this repository can know it. See that
  // field's comment in env.config.ts for the full hazard, and SECURITY.md
  // for what an operator must set. A malformed value throws here, at boot,
  // rather than being discovered later from a rate limiter that never fires.
  app.set('trust proxy', trustProxySetting(getEnv().TRUST_PROXY))

  app.use(requestId)
  app.use(requestContext)
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false }))

  // Liveness: deliberately shallow. If this checked the database, a transient
  // blip would make the orchestrator restart a healthy process — which is how
  // a slow query becomes an outage.
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', uptime: process.uptime() })
  })

  // Readiness: deep. Safe to fail — it only removes the pod from rotation.
  app.get('/health/ready', async (_request, response) => {
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
