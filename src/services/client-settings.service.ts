/**
 * @file The settings the frontends state in their copy, served by the public
 * `GET /status/client-settings`: how long each emailed link lasts and which
 * address support reads. Every value is already in the mail a person
 * receives, so the answer is the same for every caller and reveals nothing
 * about an account.
 */
import type { Env } from '@/configs/env.config'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { supportAddress } from '@/utilities/email-sender.utilities'

/**
 * Milliseconds in a second, for whole-second lifetimes.
 */
const MS_PER_SECOND = 1000

/**
 * A duration setting in whole seconds.
 * @param value - An ms()-parseable duration the environment validated.
 * @returns The duration, rounded down to the second.
 */
function seconds(value: string): number {
  return Math.floor(requireDurationMs(value) / MS_PER_SECOND)
}

/**
 * The public client settings: each link lifetime in whole seconds, rounded
 * down, and the support address customer mail names.
 */
export interface ClientSettings {
  signInLinkTtlSeconds: number
  stepUpLinkTtlSeconds: number
  invitationTtlSeconds: number
  supportEmail: string
}

/**
 * Read the client settings from the validated environment.
 * @param env - The link lifetimes and the support and general sender slice.
 * @returns The settings, as `GET /status/client-settings` answers them.
 */
export function clientSettingsFrom(
  env: Pick<
    Env,
    'SIGN_IN_LINK_TTL' | 'STEP_UP_LINK_TTL' | 'INVITATION_TTL' | 'SUPPORT_EMAIL' | 'MAIL_FROM'
  >
): ClientSettings {
  return {
    signInLinkTtlSeconds: seconds(env.SIGN_IN_LINK_TTL),
    stepUpLinkTtlSeconds: seconds(env.STEP_UP_LINK_TTL),
    invitationTtlSeconds: seconds(env.INVITATION_TTL),
    supportEmail: supportAddress(env),
  }
}
