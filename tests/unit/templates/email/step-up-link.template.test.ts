/**
 * @file The step-up confirm mail: the link, its expiry and the app name in
 * both parts, escaping in the HTML part only, a subject with no token in it,
 * and tracking metadata that stores no link and never resends.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  renderStepUpLinkTemplate,
  STEP_UP_LINK_TEMPLATE_KEY,
  STEP_UP_LINK_TEMPLATE_META,
  type StepUpLinkVariables,
} from '@/templates/email/step-up-link.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: StepUpLinkVariables = {
  firstName: 'Ada',
  confirmUrl: 'https://apex.example.test/auth/confirm?token=abc&x=1',
  expiresInMinutes: '15',
  expiresAt: '15:42 UTC on 20 October 2026',
  appName: 'Acme',
}

describe('renderStepUpLinkTemplate', () => {
  it('renders the link, the expiry and the app name in text and HTML', () => {
    const rendered = renderStepUpLinkTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(STEP_UP_LINK_TEMPLATE_KEY)
    expect(rendered.subject).toBe("Confirm it's you on Acme")
    expect(rendered.subject).not.toContain('token')
    expect(rendered.text).toContain(VARIABLES.confirmUrl)
    expect(rendered.text).toContain(
      'It works once and expires in 15 minutes, at 15:42 UTC on 20 October 2026.'
    )
    expect(rendered.text).toContain('Open this link in the browser you asked from.')
    expect(rendered.html).toContain('https://apex.example.test/auth/confirm?token=abc&amp;x=1')
    expect(rendered.html).toContain('expires in 15 minutes, at 15:42 UTC on 20 October 2026.')
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderStepUpLinkTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('&lt;b&gt;Ada&lt;/b&gt;')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.text).toContain('<b>Ada</b>')
  })

  it('has senderClass transactional, stores no …Url variable and never resends', () => {
    expect(STEP_UP_LINK_TEMPLATE_META).toEqual({
      senderClass: 'transactional',
      previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName'],
      // oxlint-disable-next-line unicorn/no-null -- the registry's "never resent" value
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'confirmUrl')
    )

    expect(() => renderStepUpLinkTemplate(partial as StepUpLinkVariables)).toThrow(/confirmUrl/)
  })
})
