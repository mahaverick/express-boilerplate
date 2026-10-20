/**
 * @file The invitation confirm mail: a subject with no tenant name and no
 * link, the link in both parts (escaped in the HTML part only), the copy
 * pinned line by line, UTM parameters that leave the link's own `token` and
 * `email` untouched, and tracking metadata that stores no link.
 */
import { describe, expect, it } from 'vitest'
import {
  INVITATION_CONFIRM_TEMPLATE_KEY,
  INVITATION_CONFIRM_TEMPLATE_META,
  renderInvitationConfirmTemplate,
  type InvitationConfirmVariables,
} from '@/templates/email/invitation-confirm.template'
import { withEmailUtm } from '@/utilities/utm.utilities'

/**
 * The confirm page's link before UTM parameters, as the link service builds it.
 */
const BARE_URL =
  'https://app.example.test/invitations/confirm?token=abc_DEF-123&email=ada%2Btest%40example.test'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: InvitationConfirmVariables = {
  firstName: 'Ada',
  tenantName: 'Acme Inc',
  role: 'editor',
  confirmUrl: withEmailUtm(BARE_URL, 'invitation_confirm', 'primary_button'),
  expiresInMinutes: '15',
  expiresAt: '15:42 UTC on 20 October 2026',
  appName: 'Acme',
}

describe('renderInvitationConfirmTemplate', () => {
  it('keeps the tenant name and the link out of the subject', () => {
    const rendered = renderInvitationConfirmTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(INVITATION_CONFIRM_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Finish joining your team on Acme')
    expect(rendered.subject).not.toContain('Acme Inc')
    expect(rendered.subject).not.toContain('http')
    expect(rendered.subject).not.toContain('token')
  })

  it('pins the text part line by line', () => {
    const rendered = renderInvitationConfirmTemplate(VARIABLES)

    expect(rendered.text.split('\n')).toEqual([
      'Hi Ada,',
      '',
      'Sign in and join Acme Inc as editor with this link. It works once and expires in 15 minutes, at 15:42 UTC on 20 October 2026.',
      '',
      VARIABLES.confirmUrl,
      '',
      "We sent it because someone opened your invitation to Acme Inc. If that wasn't you, ignore this email. Nothing changes unless someone opens this link.",
      '',
      '— The Acme team',
    ])
  })

  it('carries the same sentences and an escaped button link in the HTML part', () => {
    const rendered = renderInvitationConfirmTemplate(VARIABLES)
    const escapedUrl = VARIABLES.confirmUrl.replaceAll('&', '&amp;')

    expect(rendered.html).toContain('<p>Hi Ada,</p>')
    expect(rendered.html).toContain(
      '<p>Sign in and join Acme Inc as editor with this link. It works once and expires in 15 minutes, at 15:42 UTC on 20 October 2026.</p>'
    )
    expect(rendered.html).toContain(`<a href="${escapedUrl}"`)
    expect(rendered.html).toContain('>Join Acme Inc</a>')
    expect(rendered.html).toContain(`<p>Or paste this link into your browser: ${escapedUrl}</p>`)
    expect(rendered.html).toContain(
      '<p>We sent it because someone opened your invitation to Acme Inc. If that wasn&#39;t you, ignore this email. Nothing changes unless someone opens this link.</p>'
    )
    expect(rendered.html).toContain('<p>— The Acme team</p>')
    expect(rendered.html).not.toContain(VARIABLES.confirmUrl)
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderInvitationConfirmTemplate({
      ...VARIABLES,
      tenantName: '<b>Acme</b>',
      firstName: '"Ada"',
    })

    expect(rendered.html).toContain('&lt;b&gt;Acme&lt;/b&gt;')
    expect(rendered.html).not.toContain('<b>Acme</b>')
    expect(rendered.html).toContain('&quot;Ada&quot;')
    expect(rendered.text).toContain('<b>Acme</b>')
    expect(rendered.text).toContain('Hi "Ada",')
  })

  it('carries the four UTM pairs on the link and leaves token and email unchanged', () => {
    const url = new URL(VARIABLES.confirmUrl)

    expect(Object.fromEntries(url.searchParams)).toEqual({
      token: 'abc_DEF-123',
      email: 'ada+test@example.test',
      utm_source: 'email',
      utm_medium: 'email',
      utm_campaign: 'invitation_confirm',
      utm_content: 'primary_button',
    })
    // The link's own pairs come first, byte for byte.
    expect(VARIABLES.confirmUrl.startsWith(`${BARE_URL}&`)).toBe(true)
  })

  it('has senderClass transactional, resends the invitation and stores no …Url variable', () => {
    expect(INVITATION_CONFIRM_TEMPLATE_META).toEqual({
      senderClass: 'transactional',
      previewVariables: [
        'firstName',
        'tenantName',
        'role',
        'expiresInMinutes',
        'expiresAt',
        'appName',
      ],
      resendAction: 'invitation',
    })
    expect(INVITATION_CONFIRM_TEMPLATE_META.previewVariables).not.toContain('confirmUrl')
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'confirmUrl')
    )

    expect(() =>
      renderInvitationConfirmTemplate(partial as unknown as InvitationConfirmVariables)
    ).toThrow(/confirmUrl/)
  })
})
