/**
 * @file The route template an error reports: the mount path recorded when
 * the router matched, joined with the route path, with mount parameters put
 * back as their names, and `unmatched` when no route matched. Read from a
 * bare app's error handler, where Express has already restored `baseUrl`.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { describe, expect, it } from 'vitest'
import {
  recordRouteTemplate,
  routeTemplateOf,
  UNMATCHED_ROUTE,
} from '@/middlewares/route-template.middleware'
import { request } from '../../helpers/request'

/**
 * A route handler that fails.
 * @param _request - Unused.
 * @param _response - Unused.
 * @param next - Receives the error.
 */
function fail(_request: Request, _response: Response, next: NextFunction): void {
  next(new Error('boom'))
}

/**
 * An app whose routes all fail, answering each failure with the template its
 * error handler saw and the `baseUrl` Express left on the request.
 * @returns The app.
 */
function probeApp(): express.Express {
  const app = express()
  app.use(recordRouteTemplate)
  const merged = Router({ mergeParams: true })
  merged.get('/:stepKey/complete', fail)
  merged.get('/', fail)
  const unmerged = Router()
  unmerged.get('/detail', fail)
  const outer = Router()
  outer.use('/tenants/:id/steps', merged)
  outer.use('/things/:thingId', unmerged)
  outer.get('/users/:id/timeline', fail)
  app.use('/api/v1', outer)
  app.use((_request, _response, next) => {
    next(new Error('no route'))
  })
  app.use((_error: unknown, failed: Request, response: Response, _next: NextFunction) => {
    response.json({ template: routeTemplateOf(failed), baseUrl: failed.baseUrl })
  })
  return app
}

const TENANT_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('routeTemplateOf', () => {
  it('joins the mount path and the route path, though Express restored baseUrl', async () => {
    const response = await request(probeApp()).get(`/api/v1/users/${TENANT_ID}/timeline`)

    expect(response.body).toEqual({ template: '/api/v1/users/:id/timeline', baseUrl: '' })
  })

  it('puts a merged mount parameter back as its name', async () => {
    const response = await request(probeApp()).get(
      `/api/v1/tenants/${TENANT_ID}/steps/configure_settings/complete`
    )

    expect((response.body as { template: string }).template).toBe(
      '/api/v1/tenants/:id/steps/:stepKey/complete'
    )
  })

  it("names a router's root route by its mount path alone", async () => {
    const response = await request(probeApp()).get(`/api/v1/tenants/${TENANT_ID}/steps`)

    expect((response.body as { template: string }).template).toBe('/api/v1/tenants/:id/steps')
  })

  it('masks a UUID segment of a mount whose router does not merge its parameters', async () => {
    const response = await request(probeApp()).get(`/api/v1/things/${TENANT_ID}/detail`)

    expect((response.body as { template: string }).template).toBe('/api/v1/things/:id/detail')
  })

  it('answers unmatched when no route matched', async () => {
    const response = await request(probeApp()).get('/api/v1/nowhere')

    expect((response.body as { template: string }).template).toBe(UNMATCHED_ROUTE)
  })

  it('answers unmatched for a request the middleware never saw', () => {
    expect(routeTemplateOf({} as Request)).toBe(UNMATCHED_ROUTE)
  })
})
