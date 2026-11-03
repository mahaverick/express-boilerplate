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
 * Code of the 400 for a native request that carries browser headers.
 */
export const NATIVE_CLIENT_REFUSED = 'NATIVE_CLIENT_REFUSED'

/**
 * Code of the 400 for a browser request that carries a refresh token in its
 * body.
 */
export const REFRESH_TOKEN_IN_BODY = 'REFRESH_TOKEN_IN_BODY'
