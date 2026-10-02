/**
 * @file PostHog's reverse proxy, mounted by app.ts at `/api/v1/collect`
 * ahead of the global body parsers, so posthog-js in the frontends can use the
 * API's own origin as `api_host`. `/static/*` and `/array/*` (the recorder and
 * other lazily loaded bundles) go to the assets host, everything else (`/e/`,
 * `/i/v0/e/`, `/s/`, `/batch/`, `/flags/`, `/decide/`) to the ingest host,
 * each under the same sub-path. Bodies stream through unread: a replay POST
 * can be megabytes of gzip, and a parsed body never reaches the upstream.
 * Without `POSTHOG_PROJECT_KEY` every request answers 503.
 */
import type { ClientRequest } from 'node:http'
import { Router, type Request, type Response } from 'express'
import { createProxyMiddleware, definePlugin } from 'http-proxy-middleware'
import { isAnalyticsEnabled, posthogAssetsHost } from '@/configs/analytics.config'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { errorResponse } from '@/utilities/response.utilities'

/**
 * The path prefix the proxy is mounted at, which tracing.ts also ignores.
 */
export const ANALYTICS_PROXY_PATH = '/api/v1/collect'

/**
 * The message and code of the answer when analytics is not configured.
 */
export const ANALYTICS_UNCONFIGURED = {
  message: 'Analytics is not configured',
  code: 'service_unavailable',
} as const

/**
 * Prepare the upstream request: drop the browser's credentials, and name the
 * client by the address Express resolved under `trust proxy`.
 *
 * The refresh cookie is `__Host-refreshToken` with `Path=/`, so the browser
 * sends it here too; PostHog must never receive it, nor a bearer token.
 * `X-Forwarded-For` is replaced, not appended to: `xfwd` keeps a client's own
 * header unchanged, which would let any client choose the address PostHog
 * geolocates.
 * @param proxyRequest - The request about to go upstream.
 * @param request - The incoming request.
 */
function prepareUpstreamRequest(proxyRequest: ClientRequest, request: Request): void {
  proxyRequest.removeHeader('cookie')
  proxyRequest.removeHeader('authorization')
  if (request.ip !== undefined) proxyRequest.setHeader('x-forwarded-for', request.ip)
}

/**
 * Log an upstream failure at warn. A plugin rather than an `on.error`
 * handler: http-proxy-middleware drops its own error response (504 for a
 * refused or reset connection or a timeout, 500 otherwise) when `on.error`
 * is set, and the client would wait forever.
 */
const logUpstreamFailures = definePlugin<Request, Response>((proxyServer) => {
  proxyServer.on('error', (error) => {
    logger.warn('Analytics proxy upstream failed', { error })
  })
})

/**
 * One streaming proxy to `target`. `changeOrigin` sets the upstream `Host`;
 * `xfwd` adds `X-Forwarded-Proto`, `-Host` and `-Port`; the `User-Agent` is
 * passed through, so PostHog attributes the browser and OS correctly. An
 * upstream failure is logged and answered by http-proxy-middleware.
 * @param target - The upstream base URL, including any path prefix.
 * @returns The middleware.
 */
function proxyTo(target: string): ReturnType<typeof createProxyMiddleware<Request, Response>> {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    xfwd: true,
    on: { proxyReq: prepareUpstreamRequest },
    plugins: [logUpstreamFailures],
  })
}

/**
 * A base URL without its trailing slash, so a sub-path joins with one `/`.
 * @param url - A configured host.
 * @returns The URL without a trailing `/`.
 */
function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * The answer to every request while analytics is not configured. A plain
 * middleware rather than a controller: the proxy has no handlers of its own.
 * @param _request - Unused.
 * @param response - The response.
 */
function answerUnconfigured(_request: Request, response: Response): void {
  errorResponse(response, ANALYTICS_UNCONFIGURED.message, 503, ANALYTICS_UNCONFIGURED.code)
}

/**
 * Build the analytics proxy. The hosts are read once, here: a change needs
 * a restart, like every other variable.
 * @returns A router mounted at `/api/v1/collect` by app.ts.
 */
export function createAnalyticsProxyRouter(): Router {
  const router = Router()
  if (!isAnalyticsEnabled()) {
    router.use(answerUnconfigured)
    return router
  }
  const assetsHost = withoutTrailingSlash(posthogAssetsHost())
  router.use('/static', proxyTo(`${assetsHost}/static`))
  router.use('/array', proxyTo(`${assetsHost}/array`))
  // Express strips the mount path, so the ingest host sees /e/, /s/, /flags/ and the rest directly.
  const ingestHost = withoutTrailingSlash(getEnv().POSTHOG_HOST)
  router.use(proxyTo(ingestHost))
  return router
}
