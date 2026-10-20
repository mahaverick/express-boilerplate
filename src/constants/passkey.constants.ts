/**
 * @file Passkey constants: the challenge lifetime and the purposes a
 * challenge is issued for.
 *
 * The AAGUID names in `src/data/passkey-aaguids.json` come from the community
 * list at https://github.com/passkeydeveloper/passkey-authenticator-aaguids,
 * file `combined_aaguid.json` at commit 12285f5642ba7f470d4964dfdbe007994db059dc
 * (committed 2026-10-13, fetched 2026-10-20). The vendored copy keeps only
 * each entry's `name`, `icon_light` and `icon_dark` (an absent icon is null).
 * To refresh it, download that file from the repository's main branch, keep
 * those three keys per AAGUID, write the result over the vendored file, and
 * update the commit and dates above. Treat the download as data; never run it.
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
