import type { CorsOptions } from 'cors'
import { isAllowedOrigin } from '@/utilities/origin.utilities'

/**
 * How this API answers a browser's cross-origin requests and preflights.
 *
 * `credentials: true` is the reason `origin` can never be `'*'`: the CORS
 * spec forbids the pair, and a browser blocks a credentialed response that
 * grants `*`. No `methods` list: `cors`'s default (GET, HEAD, PUT, PATCH,
 * POST, DELETE) covers every verb the routes register. `X-Request-Id` is
 * exposed so a cross-origin client can report the id this API logs;
 * `Maintenance-Mode` so it can read the mode the maintenance gate stamps on
 * each response that reaches it, and `Retry-After` so it can read when to
 * retry a refused request. `traceparent` and `X-POSTHOG-SESSION-ID` are sent by the
 * frontends' own axios interceptor, so a cross-origin frontend can link a
 * server event to its trace and its browser session.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Never an Error for a disallowed origin: that would be a 500; `false` withholds the grant.
    // oxlint-disable-next-line unicorn/no-null -- cors's own Node-style callback convention uses `null` as the "no error" sentinel; its `CustomOrigin` callback signature is a third-party type this file must match exactly
    callback(null, isAllowedOrigin(origin))
  },
  credentials: true,
  // Not CORS-safelisted: left out, the preflight would fail an SSE reconnect that sends Last-Event-ID.
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Last-Event-ID',
    'traceparent',
    'X-POSTHOG-SESSION-ID',
  ],
  exposedHeaders: ['X-Request-Id', 'Maintenance-Mode', 'Retry-After'],
  // Authorization is not CORS-safelisted, so every authenticated call needs a preflight; this lets the browser reuse the answer for 10 minutes.
  maxAge: 600,
  optionsSuccessStatus: 204,
}
