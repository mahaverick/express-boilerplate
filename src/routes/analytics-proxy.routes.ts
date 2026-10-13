/**
 * @file PostHog's reverse proxy, mounted by app.ts at `/api/v1/collect`
 * ahead of the global body parsers, so posthog-js in the frontends can use the
 * API's own origin as `api_host`. `/static/*` and `/array/*` (the recorder and
 * other lazily loaded bundles) go to the assets host, everything else (`/e/`,
 * `/i/v0/e/`, `/s/`, `/batch/`, `/flags/`, `/decide/`) to the ingest host,
 * each under the same sub-path. Bodies stream through unread: a replay POST
 * can be megabytes of gzip, and a parsed body never reaches the upstream.
 * Without `POSTHOG_PROJECT_KEY` every request answers 503; with it, a request
 * carrying `Expect` answers 417. Every error answer, the proxy library's own
 * 5xx included, is `Cache-Control: no-store`, as `errorHandler`'s are.
 */
import { ServerResponse, type ClientRequest, type IncomingMessage } from 'node:http'
import { Router, type NextFunction, type Request, type Response } from 'express'
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
const ANALYTICS_UNCONFIGURED = {
  message: 'Analytics is not configured',
  code: 'service_unavailable',
} as const

/**
 * The message and code of the answer to a request carrying `Expect`.
 */
const EXPECT_REFUSED = {
  message: 'Expect is not supported',
  code: 'expectation_failed',
} as const

/**
 * How long the upstream connection may sit idle before the proxy gives up with
 * a 504. Without a bound, an upstream that accepts a connection and never
 * answers would hold the client's socket and the upstream's open indefinitely.
 */
const UPSTREAM_TIMEOUT_MS = 30_000

/**
 * Prepare the upstream request: drop the browser's credentials, name the
 * client address and protocol by what Express resolved under `trust proxy`,
 * and pass on the `Host` header and local port this server received, neither
 * of which `trust proxy` resolves.
 *
 * The refresh cookie has `Path=/` when `COOKIE_SECURE` is on and
 * `COOKIE_DOMAIN` is unset (`__Host-refreshToken`), so the browser sends it
 * here too; PostHog must never receive it, nor a bearer token.
 * The `X-Forwarded-*` headers are replaced, not appended to: `xfwd` only adds
 * the ones the client did not send, which would let any client choose the
 * address PostHog geolocates.
 * httpxy, which http-proxy-middleware runs on, skips this hook for a request
 * that carries `Expect`, so `refuseExpect` answers such a request first.
 * @param proxyRequest - The request about to go upstream.
 * @param request - The incoming request.
 */
function prepareUpstreamRequest(proxyRequest: ClientRequest, request: Request): void {
  proxyRequest.removeHeader('cookie')
  proxyRequest.removeHeader('authorization')
  if (request.ip === undefined) proxyRequest.removeHeader('x-forwarded-for')
  else proxyRequest.setHeader('x-forwarded-for', request.ip)
  proxyRequest.setHeader('x-forwarded-proto', request.protocol)
  const host = request.headers.host
  if (host === undefined) proxyRequest.removeHeader('x-forwarded-host')
  else proxyRequest.setHeader('x-forwarded-host', host)
  const port = request.socket.localPort
  if (port === undefined) proxyRequest.removeHeader('x-forwarded-port')
  else proxyRequest.setHeader('x-forwarded-port', String(port))
}

/**
 * Strip what the upstream must not decide on this origin: cookies (the
 * upstream's `Set-Cookie` lands on the API's origin and can name any path, so
 * it could overwrite or shadow the refresh cookie) and
 * `Access-Control-*` (the app's `cors` middleware already granted or withheld
 * this origin, and an upstream `*` would replace its grant).
 * @param proxyResponse - The upstream's response, before it reaches the client.
 */
function sanitizeUpstreamResponse(proxyResponse: IncomingMessage): void {
  for (const name of Object.keys(proxyResponse.headers)) {
    if (name === 'set-cookie' || name.startsWith('access-control-')) {
      delete proxyResponse.headers[name]
    }
  }
}

/**
 * Log an upstream failure at warn. A plugin rather than an `on.error`
 * handler: http-proxy-middleware drops its own error response (504 for a
 * refused, reset or timed-out connection or an unresolvable host, 502 for a
 * malformed upstream response, 500 otherwise) when `on.error` is set, and the
 * client would wait forever.
 */
const logUpstreamFailures = definePlugin<Request, Response>((proxyServer) => {
  proxyServer.on('error', (error) => {
    logger.warn('Analytics proxy upstream failed', { error })
  })
})

/**
 * Mark http-proxy-middleware's own error response `Cache-Control: no-store`,
 * as `errorHandler` marks every other error response. The library's default
 * plugins register before this one and its error listener writes the status
 * line, so this listener is prepended to run first; a response already
 * started is left alone.
 */
const markUpstreamFailuresNoStore = definePlugin<Request, Response>((proxyServer) => {
  proxyServer.prependListener('error', (_error, _request, response) => {
    if (response instanceof ServerResponse && !response.headersSent) {
      response.setHeader('Cache-Control', 'no-store')
    }
  })
})

/**
 * One streaming proxy to `target`. `changeOrigin` sets the upstream `Host`;
 * `xfwd` makes the `X-Forwarded-*` headers present, which
 * `prepareUpstreamRequest` then overwrites; the `User-Agent` is passed
 * through, so PostHog attributes the browser and OS correctly. An upstream
 * failure is logged and answered by http-proxy-middleware: 504 for a refused,
 * reset or timed-out connection or an unresolvable host, including an
 * upstream silent for `timeoutMs` before it answers. Once the response has started, it is cut off instead.
 * @param target - The upstream base URL, including any path prefix.
 * @param timeoutMs - How long the upstream connection may sit idle.
 * @returns The middleware.
 */
function proxyTo(
  target: string,
  timeoutMs: number
): ReturnType<typeof createProxyMiddleware<Request, Response>> {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: timeoutMs,
    on: { proxyReq: prepareUpstreamRequest, proxyRes: sanitizeUpstreamResponse },
    plugins: [markUpstreamFailuresNoStore, logUpstreamFailures],
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
 * Answer 417 to a request carrying `Expect`, before it reaches a proxy:
 * httpxy skips the `proxyReq` hook for it, so its cookies, bearer token and
 * a client-chosen `X-Forwarded-For` would reach PostHog. Browsers never send
 * `Expect`. Node answers every expectation but `100-continue` with 417
 * itself; this covers that one.
 * @param request - The incoming request.
 * @param response - The response.
 * @param next - Passes a request without `Expect` on to the proxies.
 */
function refuseExpect(request: Request, response: Response, next: NextFunction): void {
  if (request.headers.expect === undefined) {
    next()
    return
  }
  response.set('Cache-Control', 'no-store')
  errorResponse(response, EXPECT_REFUSED.message, 417, EXPECT_REFUSED.code)
}

/**
 * The answer to every request while analytics is not configured. A plain
 * middleware rather than a controller: the proxy has no handlers of its own.
 * @param _request - Unused.
 * @param response - The response.
 */
function answerUnconfigured(_request: Request, response: Response): void {
  response.set('Cache-Control', 'no-store')
  errorResponse(response, ANALYTICS_UNCONFIGURED.message, 503, ANALYTICS_UNCONFIGURED.code)
}

/**
 * Build the analytics proxy. The hosts are read once, here: a change needs
 * a restart, like every other variable.
 * @param timeoutMs - How long the upstream connection may sit idle; tests pass
 *   a short one.
 * @returns A router mounted at `/api/v1/collect` by app.ts.
 */
export function createAnalyticsProxyRouter(timeoutMs = UPSTREAM_TIMEOUT_MS): Router {
  const router = Router()
  if (!isAnalyticsEnabled()) {
    router.use(answerUnconfigured)
    return router
  }
  router.use(refuseExpect)
  const assetsHost = withoutTrailingSlash(posthogAssetsHost())
  router.use('/static', proxyTo(`${assetsHost}/static`, timeoutMs))
  router.use('/array', proxyTo(`${assetsHost}/array`, timeoutMs))
  // Express strips the mount path, so the ingest host sees /e/, /s/, /flags/ and the rest directly.
  const ingestHost = withoutTrailingSlash(getEnv().POSTHOG_HOST)
  router.use(proxyTo(ingestHost, timeoutMs))
  return router
}
