/**
 * @file What a caller knows about a mail beyond its template and recipient,
 * carried from enqueue onto its `email_messages` row.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

/**
 * The optional facts `addEmailJob` stores on a message: the tenant and
 * invitation an invitation mail is about, the frontend its token link
 * opens, and the message a staff resend was made from.
 */
export interface EmailContext {
  tenantId?: string
  invitationId?: string
  linkApp?: FrontendApp
  resentFromId?: string
}

/**
 * The option each resendable SP2 mail flow takes: the message a staff
 * resend re-runs it for, stored on the new message.
 */
export type EmailResendOptions = Pick<EmailContext, 'resentFromId'>
