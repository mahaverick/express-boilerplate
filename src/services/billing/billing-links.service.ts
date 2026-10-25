/**
 * @file The customer-app links a billing email carries: the workspace's
 * Billing page and its home. Each is built here with its UTM parameters, so
 * no template or sender spells a path or a parameter.
 */
import { getEnv } from '@/configs/env.config'
import type { EmailTemplateKey } from '@/utilities/email-template.utilities'
import { withEmailUtm } from '@/utilities/utm.utilities'

/**
 * An absolute customer-app URL for one page.
 * @param path - The page, relative to the origin.
 * @param webUrl - The customer app's origin.
 * @returns The URL, without UTM parameters.
 */
function pageUrl(path: string, webUrl: string): string {
  return new URL(path, webUrl.endsWith('/') ? webUrl : `${webUrl}/`).href
}

/**
 * The workspace's Billing page, as the one button of a billing email.
 * @param slug - The workspace's slug.
 * @param templateKey - The email carrying it: its key is the `utm_campaign`.
 * @param webUrl - The customer app's origin; defaults to the configured `WEB_URL`.
 * @returns The absolute URL with UTM parameters.
 */
export function buildBillingLink(
  slug: string,
  templateKey: EmailTemplateKey,
  webUrl: string = getEnv().WEB_URL
): string {
  return withEmailUtm(
    pageUrl(`settings/workspace/${encodeURIComponent(slug)}/billing`, webUrl),
    templateKey,
    'primary_button'
  )
}

/**
 * The workspace's home page, as the one button of a billing email.
 * @param slug - The workspace's slug.
 * @param templateKey - The email carrying it: its key is the `utm_campaign`.
 * @param webUrl - The customer app's origin; defaults to the configured `WEB_URL`.
 * @returns The absolute URL with UTM parameters.
 */
export function buildTenantHomeLink(
  slug: string,
  templateKey: EmailTemplateKey,
  webUrl: string = getEnv().WEB_URL
): string {
  return withEmailUtm(
    pageUrl(`tenants/${encodeURIComponent(slug)}`, webUrl),
    templateKey,
    'primary_button'
  )
}
