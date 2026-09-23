// src/configs/helmet.config.ts
//
// Security headers for a JSON-only API. Nothing here serves HTML, so the CSP
// forbids everything and framing entirely. CORP is `same-site`, not helmet's
// default `same-origin`: the second frontend on a sibling subdomain
// (cors.config.ts) must still be able to read responses. HSTS stays at
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
