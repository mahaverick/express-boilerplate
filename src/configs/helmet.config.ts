/**
 * @file Security headers for a JSON-only API: nothing here serves HTML, so the
 * CSP allows no source and no framing.
 */
import type { HelmetOptions } from 'helmet'

/**
 * The options `createApp()` (`src/app.ts`) passes to `helmet()`, which it
 * mounts first, so the headers are set before `cors` or any route writes a
 * response.
 *
 * `Cross-Origin-Resource-Policy` is `same-site`, not `same-origin`: it only
 * restricts no-cors loads such as an `<img>` or `<script>` embed, and
 * `same-site` lets a frontend on a sibling subdomain embed these responses
 * where `same-origin` would block it. Credentialed fetches are gated by CORS
 * alone. HSTS is off because the TLS-terminating edge owns it (the clients'
 * nginx.conf leaves it to the edge too), so an express served straight over
 * TLS sends none unless the operator adds it.
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
