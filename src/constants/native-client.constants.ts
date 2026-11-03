/**
 * @file What tells a native app's request from a browser's: the header it
 * sends and the codes its refusals carry.
 */

/**
 * The two kinds of client this API serves. A browser holds its session in a
 * cookie; a native app holds it in the response body.
 */
export const CLIENT_KINDS = ['web', 'native'] as const

/**
 * A client kind, as `resolveClientKind` sets it on `request.clientKind`.
 */
export type ClientKind = (typeof CLIENT_KINDS)[number]

/**
 * The header a native app sends with the value `native`. A browser page
 * cannot send it cross-origin, because CORS does not allow it.
 */
export const NATIVE_CLIENT_HEADER = 'x-client'

/**
 * The header on which a native app names its device, for the session list.
 */
export const DEVICE_NAME_HEADER = 'x-device-name'

/**
 * The longest device name a native app's session may record. It is the width
 * of the `device_name` column, so `clientOf` drops any longer name instead of
 * letting the insert fail.
 */
export const MAX_DEVICE_NAME_LENGTH = 64

/**
 * Code of the 400 for a native request that carries browser headers.
 */
export const NATIVE_CLIENT_REFUSED = 'NATIVE_CLIENT_REFUSED'

/**
 * The message of the 400 `NATIVE_CLIENT_REFUSED`.
 */
export const NATIVE_CLIENT_REFUSED_MESSAGE =
  'This app request came with browser headers, so we refused it. Update the app and try again.'

/**
 * The message of the 400 `NATIVE_CLIENT_REFUSED` that the Google sign-in
 * routes answer a native request.
 */
export const GOOGLE_NATIVE_REFUSED_MESSAGE =
  "Google sign-in isn't available in the app yet. Sign in with an email link or a passkey."

/**
 * Code of the 400 for a browser request that carries a refresh token in its
 * body.
 */
export const REFRESH_TOKEN_IN_BODY = 'REFRESH_TOKEN_IN_BODY'
