/**
 * @file What a mail queued after its write committed reports.
 */

/**
 * Whether the mail reached the queue. The write stands either way; the API
 * passes `emailSent` on so a client can offer a resend.
 */
export interface EmailDelivery {
  emailSent: boolean
}
