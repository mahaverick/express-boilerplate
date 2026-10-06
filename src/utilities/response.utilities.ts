/**
 * @file The single definition of the response envelope. `errorHandler`
 * (error.middleware.ts) delegates to `errorResponse` instead of building its
 * own copy.
 */
import { type Response } from 'express'
import { REQUEST_ID_HEADER } from '@/middlewares/request-id.middleware'

/**
 * Send a successful response with a consistent envelope.
 * @param response - The Express response.
 * @param data - Payload to return to the client.
 * @param message - Human-readable summary. Defaults to `'Success'`.
 * @param status - HTTP status. Defaults to 200.
 */
export function successResponse<T>(
  response: Response,
  data: T,
  message = 'Success',
  status = 200
): void {
  response.status(status).json({
    success: true,
    message,
    statusCode: status,
    data,
  })
}

/**
 * Send a successful response that carries no payload. The envelope's
 * `data` is always JSON `null`, never omitted, so every no-content
 * endpoint has one shape.
 * @param response - The Express response.
 * @param message - Human-readable summary.
 * @param status - HTTP status. Defaults to 200.
 */
export function messageResponse(response: Response, message: string, status = 200): void {
  // eslint-disable-next-line unicorn/no-null -- the envelope uses JSON null for "no data"; undefined would drop the key from the JSON
  successResponse(response, null, message, status)
}

/**
 * Send an error response with a consistent envelope.
 *
 * `status` is required, so a caller picks it rather than every error
 * becoming a 500. The request id is read off the response, where the
 * requestId middleware set it.
 * @param response - The Express response.
 * @param message - Human-readable summary of what went wrong.
 * @param status - HTTP status.
 * @param code - Optional stable, machine-readable token a client can branch on, independent of `message` or `errors`.
 * @param errors - Optional field-level detail, e.g. from a validator.
 * @param extra - Optional extra fields.
 * @param extra.errorId - The id `errorHandler` gives every 5xx fault it
 *   writes, which names its log line and, when reported, its PostHog event.
 * @param extra.mode - On a maintenance-mode 503, the mode it was refused under.
 * @param extra.since - On a maintenance-mode 503, when that mode began (or null).
 */
export function errorResponse(
  response: Response,
  message: string,
  status: number,
  code?: string,
  errors?: unknown,
  extra: { errorId?: string; mode?: string; since?: string | null } = {}
): void {
  response.status(status).json({
    success: false,
    message,
    statusCode: status,
    ...(code !== undefined && { code }),
    ...(errors !== undefined && { errors }),
    ...(extra.errorId !== undefined && { errorId: extra.errorId }),
    ...(extra.mode !== undefined && { mode: extra.mode, since: extra.since }),
    requestId: response.getHeader(REQUEST_ID_HEADER),
  })
}
