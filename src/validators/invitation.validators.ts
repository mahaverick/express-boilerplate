/**
 * @file The invitee-side input: one raw token, always in a JSON body so it
 * never appears in an API URL, and for a confirm link the address it
 * displays. The controller answers a token that fails these schemas exactly
 * like an unknown one.
 */
import { z } from 'zod'
import { INVITATION_TOKEN_LENGTH } from '@/constants/tenant.constants'

/**
 * A raw invitation token: unpadded base64url, exactly
 * `INVITATION_TOKEN_LENGTH` characters.
 */
const invitationTokenSchema = z
  .string()
  .length(INVITATION_TOKEN_LENGTH)
  .regex(/^[\w-]+$/)

/**
 * The `POST /invitations/preview` and `POST /invitations/accept` body.
 */
export const invitationTokenInputSchema = z.object({
  token: invitationTokenSchema,
})

/**
 * The `POST /invitations/confirm` body: the raw token from the confirm link,
 * and the address the link displays when it carries one. Any string is
 * accepted for both, so a malformed token, or an address that is not the
 * link's, gets the same `invitation_invalid` as an unknown token; only a
 * non-string address fails as a validation error (`errors.email`). The
 * address is trimmed and lowercased here, as the link's row stores it.
 */
export const invitationConfirmInputSchema = z.object({
  token: z.string(),
  email: z.string().trim().toLowerCase().optional(),
})
