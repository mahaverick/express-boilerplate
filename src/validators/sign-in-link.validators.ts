/**
 * @file The bodies of `POST /auth/link/request` and `POST /auth/link/verify`.
 */
import { z } from 'zod'
import { emailSchema, frontendAppSchema } from '@/validators/auth.validators'
import { redirectPathSchema } from '@/validators/redirect.validators'

/**
 * A sign-in link request: the address to mail, the frontend the link opens
 * (`web` by default), and an optional same-origin path to land on after
 * signing in, stored with the link.
 */
export const signInLinkRequestSchema = z.object({
  email: emailSchema,
  app: frontendAppSchema,
  redirect: redirectPathSchema.optional(),
})

/**
 * The validated shape of a sign-in link request.
 */
export type SignInLinkRequestInput = z.infer<typeof signInLinkRequestSchema>

/**
 * A sign-in link verify: the raw token from the link, and the address the
 * link displays when it carries one. Any string is accepted for both, so a
 * malformed token, or an address that is not the link's, gets the same
 * `LINK_INVALID` as an unknown token; only a missing or non-string token, or
 * a non-string address, fails validation. The address is trimmed and
 * lowercased here, as the link's row stores it.
 */
export const signInLinkVerifySchema = z.object({
  token: z.string(),
  email: z.string().trim().toLowerCase().optional(),
})
