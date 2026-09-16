// src/utilities/verification-mail.utilities.ts
//
// Shared module: sendVerificationMail is called by register
// (auth.controller.ts) today and by resend-verification (Task 10)
// tomorrow. Writing it in its final home now avoids Task 10 having to
// move reviewed code out of an unrelated file — one caller today is not
// premature abstraction when the second is already planned.
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import { addNotificationJob } from '@/jobs/notification.job'
import { EMAIL_VERIFICATION_TEMPLATE_KEY } from '@/templates/email/email-verification.template'
import { issueToken, requireDurationMs } from '@/utilities/token.utilities'
import { buildVerificationUrl } from '@/utilities/verification-link.utilities'

/**
 * The name a template greets an unnamed user by. `firstName` is optional
 * at registration (auth.validators.ts:82) but REQUIRED by every template —
 * requireEmailVariables throws on a missing one and sendMail catches that
 * into a 'failed' log row, so without a fallback the mail silently never
 * arrives and no status-code assertion notices.
 */
export const MISSING_FIRST_NAME_FALLBACK = 'there'

/**
 * Issue a verification token for a user, then enqueue a `verify_email`
 * notification job for them — the notification worker fans that out into an
 * in-app row (if the `in_app` channel is enabled) and the paired mail
 * carrying the verification link (email is not user-disableable for this
 * type — see `NotificationPreferenceRepository`).
 * @param user - The user to verify.
 */
export async function sendVerificationMail(user: User): Promise<void> {
  const issued = await issueToken(
    user.id,
    'email_verification',
    requireDurationMs(getEnv().EMAIL_VERIFICATION_TTL)
  )
  await addNotificationJob({
    userId: user.id,
    type: 'verify_email',
    title: 'Verify your email',
    body: `Please verify your email address for ${getEnv().APP_NAME}.`,
    metadata: { templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY },
    email: {
      to: user.email,
      templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        verificationUrl: buildVerificationUrl(issued.raw),
        appName: getEnv().APP_NAME,
      },
    },
  })
}
