/**
 * @file The one place UTM parameters are added to a link a user receives.
 * Every link builder for mail, in-app notifications and banners calls
 * `withUtm` (or `withEmailUtm`), so no template spells them out. The values
 * are fixed code constants: never an address, a name, an id or a token.
 */
import type { EmailTemplateKey } from '@/utilities/email-template.utilities'

/**
 * The channels a link is sent through, for `utm_source`.
 */
export const UTM_SOURCES = ['email', 'in_app'] as const

/**
 * The kinds of message a link is sent in, for `utm_medium`.
 */
export const UTM_MEDIUMS = ['email', 'notification', 'banner'] as const

/**
 * Which link in a message was clicked, for `utm_content`.
 */
export const UTM_CONTENTS = [
  'primary_button',
  'text_link',
  'footer_settings',
  'footer_unsubscribe',
] as const

/**
 * A `utm_source` value.
 */
type UtmSource = (typeof UTM_SOURCES)[number]

/**
 * A `utm_medium` value.
 */
type UtmMedium = (typeof UTM_MEDIUMS)[number]

/**
 * A `utm_content` value.
 */
export type UtmContent = (typeof UTM_CONTENTS)[number]

/**
 * The four parameters a link carries. `campaign` is the email template key
 * for mail and the notification type for an in-app item.
 */
export interface UtmParams {
  source: UtmSource
  medium: UtmMedium
  campaign: string
  content: UtmContent
}

/**
 * The parameter names `withUtm` owns.
 */
const UTM_PARAM_NAMES = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const

/**
 * Add the four UTM parameters after a link's own query. The query and
 * fragment it already has (`token`, `email`, `redirect`) stay byte for byte,
 * because only the UTM pairs are written; an existing `utm_*` pair is
 * replaced, not repeated.
 * @param url - An absolute URL.
 * @param utm - The four values, all constants.
 * @returns The URL with `utm_source`, `utm_medium`, `utm_campaign` and `utm_content` last in its query.
 * @throws {TypeError} When `url` is not absolute: a caller's bug.
 */
export function withUtm(url: string, utm: UtmParams): string {
  const parsed = new URL(url)
  const { hash, search } = parsed
  // `search` is the query as written, so the pairs kept below are not re-encoded.
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '' && !UTM_PARAM_NAMES.includes(pair.split('=', 1)[0] as never))
  const added = new URLSearchParams({
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_content: utm.content,
  }).toString()
  const prefix = parsed.href.slice(0, parsed.href.length - hash.length - search.length)
  return `${prefix}?${[...kept, added].join('&')}${hash}`
}

/**
 * `withUtm` for a link in an email: source and medium are both `email`, and
 * the campaign is the template's key.
 * @param url - An absolute URL.
 * @param templateKey - The template that carries the link.
 * @param content - Which link in that template.
 * @returns The URL with UTM parameters.
 */
export function withEmailUtm(
  url: string,
  templateKey: EmailTemplateKey,
  content: UtmContent
): string {
  return withUtm(url, { source: 'email', medium: 'email', campaign: templateKey, content })
}
