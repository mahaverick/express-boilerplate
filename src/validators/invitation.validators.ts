// src/validators/invitation.validators.ts
//
// The invitee-side input: one raw invitation token, always in a JSON body so
// it never appears in an API URL. The controller answers a token that fails
// this schema exactly like an unknown one.
import { z } from 'zod'
import { INVITATION_TOKEN_LENGTH } from '@/constants/tenant.constants'

/**
 * A raw invitation token: unpadded base64url, exactly
 * `INVITATION_TOKEN_LENGTH` characters.
 */
export const invitationTokenSchema = z
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
 * The validated shape of `invitationTokenInputSchema`.
 */
export type InvitationTokenInput = z.infer<typeof invitationTokenInputSchema>
