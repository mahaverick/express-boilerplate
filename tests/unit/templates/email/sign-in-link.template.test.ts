/**
 * @file The sign-in link mail: the link, its expiry and the app name in both
 * parts, escaping in the HTML part only, a subject with no token in it, the
 * staff-sent sentence, and tracking metadata that stores no link.
 */
import { describe, expect, it } from 'vitest'
import {
  renderSignInLinkTemplate,
  SIGN_IN_LINK_TEMPLATE_KEY,
  SIGN_IN_LINK_TEMPLATE_META,
  type SignInLinkVariables,
} from '@/templates/email/sign-in-link.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: SignInLinkVariables = {
  firstName: 'Ada',
  signInUrl: 'https://app.example.test/auth/link?token=abc&email=ada%40example.test',
  expiresInMinutes: '15',
  appName: 'Acme',
  reason: 'self',
}

describe('renderSignInLinkTemplate', () => {
  it('renders the link, the 15-minute expiry and the app name in text and HTML', () => {
    const rendered = renderSignInLinkTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(SIGN_IN_LINK_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Sign in to Acme')
    expect(rendered.subject).not.toContain('token')
    expect(rendered.text).toContain(VARIABLES.signInUrl)
    expect(rendered.text).toContain('Sign in to Acme.')
    expect(rendered.text).toContain('This link works once and expires in 15 minutes.')
    expect(rendered.text).toContain("If you didn't ask for it, ignore this email.")
    expect(rendered.html).toContain(
      'https://app.example.test/auth/link?token=abc&amp;email=ada%40example.test'
    )
    expect(rendered.html).toContain('expires in 15 minutes')
    expect(rendered.html).toContain('Acme')
    expect(rendered.text).not.toContain('team admin')
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderSignInLinkTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('&lt;b&gt;Ada&lt;/b&gt;')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.text).toContain('<b>Ada</b>')
  })

  it('has senderClass transactional, resends as a fresh link and stores no …Url variable', () => {
    expect(SIGN_IN_LINK_TEMPLATE_META).toEqual({
      senderClass: 'transactional',
      previewVariables: ['firstName', 'expiresInMinutes', 'appName', 'reason'],
      resendAction: 'sign_in_link',
    })
    expect(SIGN_IN_LINK_TEMPLATE_META.previewVariables).not.toContain('signInUrl')
  })

  it('says a team admin sent it when reason is staff', () => {
    const rendered = renderSignInLinkTemplate({ ...VARIABLES, reason: 'staff' })

    expect(rendered.text).toContain('A team admin sent you this link.')
    expect(rendered.html).toContain('A team admin sent you this link.')
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'signInUrl')
    )

    expect(() => renderSignInLinkTemplate(partial as SignInLinkVariables)).toThrow(/signInUrl/)
  })
})
