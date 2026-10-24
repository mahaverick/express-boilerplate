/**
 * @file Every template's tracking metadata, by key, and the check that no
 * template stores a secret. The check runs when this module loads, so a
 * template listing a `…Url` or `…Token` variable for storage fails at boot,
 * before anything can store it.
 */
import { SECRET_VARIABLE_PATTERN } from '@/constants/email.constants'
import { INTERVAL_SWITCH_SCHEDULED_TEMPLATE_META } from '@/templates/email/interval-switch-scheduled.template'
import { INVITATION_CONFIRM_TEMPLATE_META } from '@/templates/email/invitation-confirm.template'
import { MAINTENANCE_MODE_CHANGED_TEMPLATE_META } from '@/templates/email/maintenance-mode-changed.template'
import { MOVED_TO_FREE_TEMPLATE_META } from '@/templates/email/moved-to-free.template'
import { ONBOARDING_REMINDER_TEMPLATE_META } from '@/templates/email/onboarding-reminder.template'
import { PAID_CANCELLED_TEMPLATE_META } from '@/templates/email/paid-cancelled.template'
import { PAID_WELCOME_TEMPLATE_META } from '@/templates/email/paid-welcome.template'
import { PASSKEY_CREATED_TEMPLATE_META } from '@/templates/email/passkey-created.template'
import { PASSKEY_DELETED_TEMPLATE_META } from '@/templates/email/passkey-deleted.template'
import { PAYER_LEFT_TEMPLATE_META } from '@/templates/email/payer-left.template'
import { PAYMENT_FAILED_TEMPLATE_META } from '@/templates/email/payment-failed.template'
import { RENEWAL_UPCOMING_TEMPLATE_META } from '@/templates/email/renewal-upcoming.template'
import { SIGN_IN_LINK_TEMPLATE_META } from '@/templates/email/sign-in-link.template'
import { STEP_UP_LINK_TEMPLATE_META } from '@/templates/email/step-up-link.template'
import { TENANT_INVITATION_TEMPLATE_META } from '@/templates/email/tenant-invitation.template'
import { TRIAL_ENDED_TEMPLATE_META } from '@/templates/email/trial-ended.template'
import { TRIAL_ENDING_TEMPLATE_META } from '@/templates/email/trial-ending.template'
import { TRIAL_ENDS_TODAY_TEMPLATE_META } from '@/templates/email/trial-ends-today.template'
import { TRIAL_MIDPOINT_TEMPLATE_META } from '@/templates/email/trial-midpoint.template'
import { TRIAL_STARTED_TEMPLATE_META } from '@/templates/email/trial-started.template'
import { UPGRADE_REQUEST_FULFILLED_TEMPLATE_META } from '@/templates/email/upgrade-request-fulfilled.template'
import { UPGRADE_REQUESTED_TEMPLATE_META } from '@/templates/email/upgrade-requested.template'
import { WELCOME_TEMPLATE_META } from '@/templates/email/welcome.template'
import { WINBACK_TEMPLATE_META } from '@/templates/email/winback.template'
import type { EmailTemplateKey, EmailTemplateMetaEntry } from '@/utilities/email-template.utilities'

/**
 * Refuse any template whose stored variables include a secret-named key.
 * The type of each `…_TEMPLATE_META` already forbids one; this catches a
 * value that reached the registry around the type (a cast, a widened
 * literal). `EMAIL_TEMPLATE_META` is built through it, so the check runs
 * when this module loads.
 * @param registry - The metadata to check.
 * @returns `registry`, unchanged, once every template has passed.
 * @throws {Error} Naming the template and the key, for the first secret-named stored variable.
 */
export function assertTemplateMetaSafe<T extends Readonly<Record<string, EmailTemplateMetaEntry>>>(
  registry: T
): T {
  for (const [templateKey, meta] of Object.entries(registry)) {
    const secret = meta.previewVariables.find((name) => SECRET_VARIABLE_PATTERN.test(name))
    if (secret !== undefined) {
      throw new Error(
        `Email template "${templateKey}" lists "${secret}" in previewVariables; a variable ending in Url or Token carries a secret and must never be stored.`
      )
    }
  }
  return registry
}

/**
 * Each template's sender class, stored variables and resend action. A
 * `Record` over `EmailTemplateKey`, so a new template does not compile until
 * it has an entry.
 */
export const EMAIL_TEMPLATE_META: Readonly<Record<EmailTemplateKey, EmailTemplateMetaEntry>> =
  assertTemplateMetaSafe({
    tenant_invitation: TENANT_INVITATION_TEMPLATE_META,
    onboarding_reminder: ONBOARDING_REMINDER_TEMPLATE_META,
    maintenance_mode_changed: MAINTENANCE_MODE_CHANGED_TEMPLATE_META,
    sign_in_link: SIGN_IN_LINK_TEMPLATE_META,
    step_up_link: STEP_UP_LINK_TEMPLATE_META,
    welcome: WELCOME_TEMPLATE_META,
    invitation_confirm: INVITATION_CONFIRM_TEMPLATE_META,
    passkey_created: PASSKEY_CREATED_TEMPLATE_META,
    passkey_deleted: PASSKEY_DELETED_TEMPLATE_META,
    trial_started: TRIAL_STARTED_TEMPLATE_META,
    trial_midpoint: TRIAL_MIDPOINT_TEMPLATE_META,
    trial_ending: TRIAL_ENDING_TEMPLATE_META,
    trial_ends_today: TRIAL_ENDS_TODAY_TEMPLATE_META,
    trial_ended: TRIAL_ENDED_TEMPLATE_META,
    paid_welcome: PAID_WELCOME_TEMPLATE_META,
    renewal_upcoming: RENEWAL_UPCOMING_TEMPLATE_META,
    payment_failed: PAYMENT_FAILED_TEMPLATE_META,
    moved_to_free: MOVED_TO_FREE_TEMPLATE_META,
    paid_cancelled: PAID_CANCELLED_TEMPLATE_META,
    interval_switch_scheduled: INTERVAL_SWITCH_SCHEDULED_TEMPLATE_META,
    payer_left: PAYER_LEFT_TEMPLATE_META,
    upgrade_requested: UPGRADE_REQUESTED_TEMPLATE_META,
    upgrade_request_fulfilled: UPGRADE_REQUEST_FULFILLED_TEMPLATE_META,
    winback: WINBACK_TEMPLATE_META,
  })
