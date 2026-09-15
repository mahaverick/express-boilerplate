// src/app.ts
//
// Builds the app and returns it. No listen, no workers, no side effects —
// that is what makes supertest able to import it, and it is why this is a
// separate file from server.ts. core's single 38k index.ts is the thing this
// split exists to avoid.
import express, { type Express } from 'express'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { createApiRouter } from '@/routes/index.routes'
import { isDatabaseReachable } from '@/services/database.service'
import { isRedisReachable } from '@/services/redis.service'

/**
 * Build the Express application.
 * @returns A configured app with no listening socket.
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')
  app.use(requestId)
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
    const [database, redis] = await Promise.all([isDatabaseReachable(), isRedisReachable()])
    const isReady = database && redis
    response.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not-ready',
      checks: { database, redis },
    })
  })

  app.use('/api/v1', createApiRouter())

  app.use((_request, _response, next) => {
    next(new HttpError('Not found', 404))
  })
  app.use(errorHandler)

  return app
}
