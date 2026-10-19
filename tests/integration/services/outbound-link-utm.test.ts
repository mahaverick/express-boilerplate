/**
 * @file Every link a user receives carries UTM parameters. The cases are a
 * `Record` over the template registry, so a template added without an entry
 * here does not compile, and the links are built by the same functions the
 * real flows call, then rendered through the template that carries them.
 */
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { buildInvitationAcceptUrl } from '@/services/frontend-links.service'
import { buildSignInLinkUrl, buildStepUpConfirmUrl } from '@/services/link-token.service'
import { renderForMessage, type MailMessage } from '@/services/mailer.service'
import { buildTenantOverviewLink } from '@/services/platform-onboarding.service'
import { EMAIL_TEMPLATE_META } from '@/templates/email/email-template-meta.template'
import { EMAIL_TEMPLATE_KEYS, type EmailTemplateKey } from '@/utilities/email-template.utilities'
import { UTM_CONTENTS, type UtmContent } from '@/utilities/utm.utilities'

/**
 * A raw link token: 43 base64url characters, like a real one.
 */
const RAW = 'a'.repeat(43)

/**
 * A stored redirect with its own query and fragment.
 */
const REDIRECT = '/tenants/acme/members?tenant=acme&tab=2#x'

/**
 * The address a sign-in link names.
 */
const EMAIL = 'person+tag@example.test'

/**
 * Where a template's links come from: the message with those links in
 * place, and the `utm_content` each must carry (empty when it has no link).
 */
interface LinkCase {
  message: MailMessage
  contents: readonly UtmContent[]
}

/**
 * One case per template, built with the real link builders. Typed over
 * `EmailTemplateKey`, so a new template fails to compile until it is here.
 */
const CASES: Record<EmailTemplateKey, () => LinkCase> = {
  tenant_invitation: () => ({
    message: {
      to: EMAIL,
      templateKey: 'tenant_invitation',
      variables: {
        tenantName: 'Acme',
        inviterName: 'Grace',
        role: 'viewer',
        acceptUrl: buildInvitationAcceptUrl(RAW, getEnv().WEB_URL),
        expiresInDays: '3',
        appName: 'App',
      },
    },
    contents: ['primary_button'],
  }),
  onboarding_reminder: () => ({
    message: {
      to: EMAIL,
      templateKey: 'onboarding_reminder',
      variables: {
        tenantName: 'Acme',
        appName: 'App',
        nextStep: 'Invite a teammate',
        overviewLink: buildTenantOverviewLink('acme', getEnv().WEB_URL),
      },
    },
    contents: ['primary_button'],
  }),
  maintenance_mode_changed: () => ({
    message: {
      to: EMAIL,
      templateKey: 'maintenance_mode_changed',
      variables: {
        firstName: 'Ada',
        appName: 'App',
        mode: 'full',
        actorName: 'Grace',
        reason: 'Database upgrade',
        changedAt: '2026-10-06T10:42:00.000Z',
      },
    },
    contents: [],
  }),
  sign_in_link: () => ({
    message: {
      to: EMAIL,
      templateKey: 'sign_in_link',
      variables: {
        firstName: 'Ada',
        signInUrl: buildSignInLinkUrl(
          RAW,
          { email: EMAIL, app: 'web', redirect: REDIRECT },
          'sign_in_link'
        ),
        expiresInMinutes: '15',
        appName: 'App',
        reason: 'self',
      },
    },
    contents: ['text_link'],
  }),
  step_up_link: () => ({
    message: {
      to: EMAIL,
      templateKey: 'step_up_link',
      variables: {
        firstName: 'Ada',
        confirmUrl: buildStepUpConfirmUrl(RAW),
        expiresInMinutes: '15',
        appName: 'App',
      },
    },
    contents: ['text_link'],
  }),
  welcome: () => ({
    message: {
      to: EMAIL,
      templateKey: 'welcome',
      variables: {
        firstName: 'Ada',
        signInUrl: buildSignInLinkUrl(
          RAW,
          // eslint-disable-next-line unicorn/no-null -- a row with no stored redirect
          { email: EMAIL, app: 'web', redirect: null },
          'welcome'
        ),
        expiresInMinutes: '15',
        appName: 'App',
      },
    },
    contents: ['text_link'],
  }),
}

/**
 * Every http(s) URL in a rendered part, with HTML entities decoded.
 * @param text - The rendered text or HTML.
 * @returns The URLs, in order of appearance, quotes and brackets excluded.
 */
function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map((url) => url.replaceAll('&amp;', '&'))
}

/**
 * Alphabetical order for key lists.
 * @param a - One key.
 * @param b - Another key.
 * @returns The `localeCompare` order.
 */
function byName(a: string, b: string): number {
  return a.localeCompare(b)
}

describe('links we send', () => {
  it('has a case for every template in the registry', () => {
    expect(Object.keys(CASES).toSorted(byName)).toEqual([...EMAIL_TEMPLATE_KEYS].toSorted(byName))
    expect(Object.keys(EMAIL_TEMPLATE_META).toSorted(byName)).toEqual(
      Object.keys(CASES).toSorted(byName)
    )
  })

  describe.each(EMAIL_TEMPLATE_KEYS)('%s', (key) => {
    it('puts UTM parameters on every link in the text and HTML parts', () => {
      const { message, contents } = CASES[key]()
      const rendered = renderForMessage(message)
      expect(urlsIn(rendered.text)).toHaveLength(contents.length)
      for (const part of [rendered.text, rendered.html]) {
        const urls = urlsIn(part)
        expect(urls.length).toBeGreaterThanOrEqual(contents.length)
        for (const url of urls) {
          const { searchParams } = new URL(url)
          expect(searchParams.get('utm_source')).toBe('email')
          expect(searchParams.get('utm_medium')).toBe('email')
          expect(searchParams.get('utm_campaign')).toBe(key)
          expect(contents).toContain(searchParams.get('utm_content'))
        }
      }
    })

    it('holds no address, uuid or token-shaped string in any UTM value', () => {
      const { message } = CASES[key]()
      const rendered = renderForMessage(message)
      for (const url of urlsIn(rendered.text)) {
        const params = [...new URL(url).searchParams]
        for (const [name, value] of params) {
          if (!name.startsWith('utm_')) continue
          expect(value).not.toContain('@')
          expect(value).not.toMatch(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i)
          expect(value).not.toMatch(/^[\w-]{32,}$/)
          expect(value).toMatch(/^[a-z_]+$/)
          if (name === 'utm_content') expect(UTM_CONTENTS).toContain(value)
        }
      }
    })
  })

  it('keeps the sign-in link token, email and redirect as the builder wrote them', () => {
    const row = { email: EMAIL, app: 'web' as const, redirect: REDIRECT }
    const url = new URL(buildSignInLinkUrl(RAW, row, 'sign_in_link'))
    expect(url.searchParams.get('token')).toBe(RAW)
    expect(url.searchParams.get('email')).toBe(EMAIL)
    expect(url.searchParams.get('redirect')).toBe(REDIRECT)
    // UTM sits on the outer URL: the redirect value is the stored one, no UTM inside.
    expect(url.searchParams.get('redirect')).not.toContain('utm_')
    // The query up to the first UTM parameter is the link without UTM, unchanged.
    expect(url.search.split('&utm_source', 1)[0]).toBe(
      `?token=${RAW}&email=${encodeURIComponent(EMAIL)}&redirect=${encodeURIComponent(REDIRECT)}`
    )
  })

  it('names the welcome mail as the campaign of a welcome link', () => {
    // eslint-disable-next-line unicorn/no-null -- a row with no stored redirect
    const row = { email: EMAIL, app: 'web' as const, redirect: null }
    expect(new URL(buildSignInLinkUrl(RAW, row, 'welcome')).searchParams.get('utm_campaign')).toBe(
      'welcome'
    )
  })

  it('builds a link for the longest redirect a request may store', () => {
    const redirect = `/${'a'.repeat(2047)}`
    const url = buildSignInLinkUrl(RAW, { email: EMAIL, app: 'web', redirect }, 'sign_in_link')
    expect(new URL(url).searchParams.get('redirect')).toBe(redirect)
    expect(new URL(url).searchParams.get('utm_source')).toBe('email')
  })
})
