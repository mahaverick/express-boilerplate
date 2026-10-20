/**
 * @file Passkey constants: the challenge lifetime and the purposes a
 * challenge is issued for.
 *
 * The AAGUID names in `src/data/passkey-aaguids.json` come from the community
 * list at https://github.com/passkeydeveloper/passkey-authenticator-aaguids,
 * file `combined_aaguid.json`. The vendored file records its repo, commit and
 * fetch date in its `source` field, and stores each distinct icon once in
 * `icons`; an entry's `light` and `dark` index that table (an absent icon, or
 * one over 30,000 characters, is null). To refresh it: download
 * `combined_aaguid.json` from the repository's main branch into a new empty
 * directory, note the commit, then run
 * `node scripts/vendor-passkey-aaguids.mjs <path> <commit> <date>`. Treat the
 * download as data; never run it. `pnpm build` copies `src/data` to `dist/data`.
 */

/**
 * What a passkey challenge is for. A challenge issued for one purpose is
 * refused for any other.
 */
export type PasskeyPurpose = 'sign_in' | 'step_up' | 'create'

/**
 * How long a passkey challenge lives in Redis: 5 minutes. A challenge is also
 * single-use, so it ends earlier when it is read.
 */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000

/**
 * The routes an account with no passkey may still call when `PASSKEY_MODE` is
 * `required`, as `METHOD /full/path` keys (an upper-case method, a lower-case
 * path with no trailing slash and no route parameter). Everything an account
 * needs to create its first passkey is here: the list, the creation pair,
 * confirming it's them by emailed link (an invitation's one-click session is
 * not a recent sign-in, and creating a passkey needs one), the profile and
 * provider reads a client needs to render the page, and sign-out. The logout
 * route reads the refresh cookie and never meets `requireAuth`; it is listed
 * so the rule holds if that changes.
 */
export const PASSKEY_SETUP_ALLOWED: ReadonlySet<string> = new Set([
  'GET /api/v1/auth/passkeys',
  'POST /api/v1/auth/passkeys/registration/options',
  'POST /api/v1/auth/passkeys/registration/verify',
  'GET /api/v1/auth/passkeys/config',
  'POST /api/v1/auth/step-up/link/request',
  'POST /api/v1/auth/step-up/link/verify',
  'POST /api/v1/auth/logout',
  'GET /api/v1/profile',
  'GET /api/v1/auth/providers',
])
