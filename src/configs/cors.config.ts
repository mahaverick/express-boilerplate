import type { CorsOptions } from 'cors'
import { isAllowedOrigin } from '@/utilities/origin.utilities'

/**
 * How this API answers a browser's cross-origin questions.
 *
 * `credentials: true` is the reason `origin` can never be `'*'`: the CORS
 * spec forbids the pair, and a browser discards the response rather than
 * warning about it. No `methods` list: `cors`'s default covers every verb
 * this API registers and cannot drift as routes are added. `X-Request-Id` is
 * exposed so a cross-origin client can report the id this API logs.
 * `traceparent` and `X-POSTHOG-SESSION-ID` are set by the frontends' own
 * axios interceptor, so a cross-origin frontend can link a server event to
 * its trace and its browser session.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Never an Error for a disallowed origin: that would be a 500; `false` withholds the grant.
    // eslint-disable-next-line unicorn/no-null -- cors's own Node-style callback convention uses `null` as the "no error" sentinel; its `CustomOrigin` callback signature is a third-party type this file must match exactly
    callback(null, isAllowedOrigin(origin))
  },
  credentials: true,
  // Without Last-Event-ID a cross-origin SSE client silently loses replay on reconnect.
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Last-Event-ID',
    'traceparent',
    'X-POSTHOG-SESSION-ID',
  ],
  exposedHeaders: ['X-Request-Id'],
  // Chrome caps preflight caching at 600s; Authorization makes every call preflight.
  maxAge: 600,
  optionsSuccessStatus: 204,
}
