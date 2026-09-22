import type { CorsOptions } from 'cors'
import { isAllowedOrigin } from '@/utilities/origin.utilities'

/**
 * How this API answers a browser's cross-origin questions.
 *
 * `credentials: true` is the reason `origin` can never be `'*'`: the CORS
 * spec forbids the pair, and a browser discards the response rather than
 * warning about it.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Never pass an Error for a disallowed origin. Doing so turns a browser
    // CORS block — which is the correct, quiet outcome — into a 500 in this
    // API's own error handler and logs. `false` withholds the grant header,
    // which is exactly what blocks the browser.
    // eslint-disable-next-line unicorn/no-null -- cors's own Node-style callback convention uses `null` as the "no error" sentinel; its `CustomOrigin` callback signature is a third-party type this file must match exactly
    callback(null, isAllowedOrigin(origin))
  },
  credentials: true,
  // No `methods` list here, deliberately. A hand-maintained list
  // (['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) once shipped here and
  // silently dropped PUT — `PUT /api/v1/notifications/preferences`
  // (notification.routes.ts) preflighted, got back a grant that didn't
  // include PUT, and a browser blocked every cross-origin call to it,
  // invisibly, because same-origin dev never sends a preflight at all.
  // `cors`'s own default (`GET,HEAD,PUT,PATCH,POST,DELETE`) already covers
  // every verb this API registers, and — unlike a list here — cannot drift
  // out of sync as routes are added.
  // `Last-Event-ID` is load-bearing. The SSE stream's replay-on-reconnect is
  // implemented server-side and tested, but a cross-origin browser cannot
  // send the header unless it is named here — and the failure is silent:
  // replay simply never happens.
  allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'],
  // Unexposed response headers are invisible to JavaScript. `X-Request-Id`
  // is exposed so a cross-origin client can log or display the same
  // correlation id this API's own logs use — token state travels in the
  // error envelope's `code` field (error.middleware.ts), which needs no
  // exposure since it is already in the JSON body the client reads anyway.
  exposedHeaders: ['X-Request-Id'],
  // Chrome caps preflight caching at 600s and Firefox at 86400; 600 is the
  // value both honour. Without it, every cross-origin call preflights,
  // because `Authorization` is not a CORS-safelisted header.
  maxAge: 600,
  optionsSuccessStatus: 204,
}
