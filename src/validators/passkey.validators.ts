/**
 * @file The bodies of the passkey management routes: the registration
 * options and verify bodies, and a rename.
 */
import { z } from 'zod'
import { frontendAppSchema } from '@/validators/auth.validators'

/**
 * The longest passkey name, matching the `name` column.
 */
export const PASSKEY_NAME_MAX_LENGTH = 64

/**
 * A registration options request: the frontend the passkey is created from
 * (`web` by default), which the security mail's link opens. Strict, so an
 * unknown key is a 400.
 */
export const passkeyRegistrationOptionsSchema = z.strictObject({
  app: frontendAppSchema,
})

/**
 * One authenticator transport name, such as `internal` or `hybrid`.
 */
const transportSchema = z.string().max(32)

/**
 * The JSON `navigator.credentials.create()` yields once a browser library
 * has encoded its buffers as base64url. Field sizes are bounded; the
 * contents are checked by `@simplewebauthn/server`, so a malformed value is a
 * failed verification, not a validation error.
 */
const registrationResponseSchema = z.object({
  id: z.string().min(1).max(1400),
  rawId: z.string().min(1).max(1400),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  response: z.looseObject({
    clientDataJSON: z.string().min(1).max(4096),
    attestationObject: z.string().min(1).max(32_768),
    transports: z.array(transportSchema).max(10).optional(),
  }),
})

/**
 * A registration verify request: the challenge id the options answered, the
 * browser's response, and the frontend the passkey is created from.
 */
export const passkeyRegistrationVerifySchema = z.object({
  challengeId: z.string().min(1).max(64),
  response: registrationResponseSchema,
  app: frontendAppSchema,
})

/**
 * A rename: the new name, trimmed, 1 to 64 characters.
 */
export const passkeyRenameSchema = z.strictObject({
  name: z.string().trim().min(1).max(PASSKEY_NAME_MAX_LENGTH),
})

/**
 * The query of a delete: the frontend the request comes from (`web` by
 * default), which the security mail's link opens.
 */
export const passkeyDeleteQuerySchema = z.object({
  app: frontendAppSchema,
})
