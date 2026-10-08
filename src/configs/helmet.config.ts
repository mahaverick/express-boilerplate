/**
 * @file Security headers for a JSON-only API: nothing here serves HTML, so the
 * CSP forbids every source and all framing.
 */
import type { HelmetOptions } from 'helmet'

/**
 * helmet configuration mounted first in `createApp()` (`src/app.ts`), ahead
 * of `cors` and every route, so no response can be produced without these
 * headers attached. CORP is `same-site`, not `same-origin`: it applies only to
 * no-cors embeds, and keeps one from a sibling-subdomain frontend working;
 * credentialed fetches are gated by CORS alone. HSTS is off: the
 * TLS-terminating edge owns it (the clients' nginx.conf says the same), so an
 * express served straight over TLS with no edge sends none until the
 * operator adds it there.
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
  strictTransportSecurity: false,
}
