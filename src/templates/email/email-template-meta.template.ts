/**
 * @file Every template's tracking metadata, by key, and the check that no
 * template stores a secret. The check runs when this module loads, so a
 * template listing a `…Url` or `…Token` variable for storage fails at boot,
 * before anything can store it.
 */
import { SECRET_VARIABLE_PATTERN } from '@/constants/email.constants'
import { MAINTENANCE_MODE_CHANGED_TEMPLATE_META } from '@/templates/email/maintenance-mode-changed.template'
import { ONBOARDING_REMINDER_TEMPLATE_META } from '@/templates/email/onboarding-reminder.template'
import { SIGN_IN_LINK_TEMPLATE_META } from '@/templates/email/sign-in-link.template'
import { STEP_UP_LINK_TEMPLATE_META } from '@/templates/email/step-up-link.template'
import { TENANT_INVITATION_TEMPLATE_META } from '@/templates/email/tenant-invitation.template'
import { WELCOME_TEMPLATE_META } from '@/templates/email/welcome.template'
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
  })
