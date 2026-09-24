// src/configs/helmet.config.ts
//
// Security headers for a JSON-only API. Nothing here serves HTML, so the CSP
// forbids everything and framing entirely. CORP is `same-site`, not helmet's
// default `same-origin`: it is only consulted for a no-cors request (an
// `<img>`/`<script>`-style embed), never for the credentialed fetch/XHR the
// frontends actually make — those are gated by CORS alone (cors.config.ts).
// `same-site` keeps a no-cors embed from the sibling-subdomain frontend
// working, which is what a same-site deployment would expect. HSTS stays at
// helmet's default — browsers only honour it over HTTPS.
import type { HelmetOptions } from 'helmet'

/**
 * helmet configuration mounted first in `createApp()` (`src/app.ts`), ahead
 * of `cors` and every route, so no response can be produced without these
 * headers attached.
 */
export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
}
