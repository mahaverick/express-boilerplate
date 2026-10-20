/**
 * @file The welcome mail: the account-ready line, the link, its expiry and
 * the app name in both parts, escaping in the HTML part only, a subject with
 * no token in it, and tracking metadata that stores no link.
 */
import { describe, expect, it } from 'vitest'
import {
  renderWelcomeTemplate,
  WELCOME_TEMPLATE_KEY,
  WELCOME_TEMPLATE_META,
  type WelcomeVariables,
} from '@/templates/email/welcome.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: WelcomeVariables = {
  firstName: 'Ada',
  signInUrl: 'https://app.example.test/auth/link?token=abc&email=ada%40example.test',
  expiresInMinutes: '15',
  expiresAt: '15:42 UTC on 20 October 2026',
  appName: 'Acme',
}

describe('renderWelcomeTemplate', () => {
  it('says the account is ready and carries the link, its expiry and the app name', () => {
    const rendered = renderWelcomeTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(WELCOME_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Your Acme account is ready')
    expect(rendered.subject).not.toContain('token')
    expect(rendered.text).toContain('Your Acme account is ready. Sign in with this link.')
    expect(rendered.text).toContain(
      'It works once and expires in 15 minutes, at 15:42 UTC on 20 October 2026.'
    )
    expect(rendered.text).toContain(VARIABLES.signInUrl)
    expect(rendered.text).toContain(
      'If the link expires, enter your email address on the Acme sign-in page to get a new one.'
    )
    expect(rendered.html).toContain('Your Acme account is ready. Sign in with this link.')
    expect(rendered.html).toContain(
      'https://app.example.test/auth/link?token=abc&amp;email=ada%40example.test'
    )
    expect(rendered.html).toContain('expires in 15 minutes, at 15:42 UTC on 20 October 2026.')
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderWelcomeTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('&lt;b&gt;Ada&lt;/b&gt;')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.text).toContain('<b>Ada</b>')
  })

  it('has senderClass transactional, resends as a fresh sign-in link and stores no …Url variable', () => {
    expect(WELCOME_TEMPLATE_META).toEqual({
      senderClass: 'transactional',
      previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName'],
      resendAction: 'sign_in_link',
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'signInUrl')
    )

    expect(() => renderWelcomeTemplate(partial as WelcomeVariables)).toThrow(/signInUrl/)
  })
})
