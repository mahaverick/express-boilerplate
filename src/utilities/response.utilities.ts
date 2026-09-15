// src/utilities/response.utilities.ts
//
// The single definition of the response envelope: { success, message,
// statusCode, ... }. errorHandler (src/middlewares/error.middleware.ts)
// delegates to errorResponse() below rather than building its own copy —
// two definitions of the same client-facing contract is how they drift.
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
 * Send an error response with a consistent envelope.
 *
 * Unlike `successResponse`, `status` is required, not defaulted — an error
 * helper exists precisely so a caller picks the right status instead of
 * every error silently becoming a 500. The correlation id is read off the
 * response itself (set by requestId middleware, which runs before any
 * handler) rather than accepted as a parameter — every caller already has a
 * response, so passing the same id back in would just be one more thing to
 * get wrong.
 *
 * `code` and `errors` are separate, independent fields — see
 * error.middleware.ts's header comment for why they are not one overloaded
 * field.
 * @param response - The Express response.
 * @param message - Human-readable summary of what went wrong.
 * @param status - HTTP status.
 * @param code - Optional stable, machine-readable token a client can branch on, independent of `message` or `errors`.
 * @param errors - Optional field-level detail, e.g. from a validator.
 */
export function errorResponse(
  response: Response,
  message: string,
  status: number,
  code?: string,
  errors?: unknown
): void {
  response.status(status).json({
    success: false,
    message,
    statusCode: status,
    ...(code !== undefined && { code }),
    ...(errors !== undefined && { errors }),
    requestId: response.getHeader(REQUEST_ID_HEADER),
  })
}
