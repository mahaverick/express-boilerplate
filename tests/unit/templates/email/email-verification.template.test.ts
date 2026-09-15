// tests/unit/templates/email/email-verification.template.test.ts
//
// Pure rendering — no database, no container, no I/O — so this lives under
// tests/unit/, not tests/integration/ (CLAUDE.md).
import { describe, expect, it } from 'vitest'
import {
  EMAIL_VERIFICATION_TEMPLATE_KEY,
  renderEmailVerificationTemplate,
  type EmailVerificationVariables,
} from '@/templates/email/email-verification.template'

const validVariables: EmailVerificationVariables = {
  firstName: 'Ada',
  verificationUrl: 'https://example.test/verify?token=abc123',
  appName: 'Acme',
}

describe('renderEmailVerificationTemplate', () => {
  it('reports its own template key', () => {
    expect(renderEmailVerificationTemplate(validVariables).templateKey).toBe(
      EMAIL_VERIFICATION_TEMPLATE_KEY
    )
  })

  it('a rendered template contains the interpolated values, in both parts', () => {
    const rendered = renderEmailVerificationTemplate(validVariables)
    expect(rendered.text).toContain('Ada')
    expect(rendered.text).toContain('Acme')
    expect(rendered.text).toContain(validVariables.verificationUrl)
    expect(rendered.html).toContain('Ada')
    expect(rendered.html).toContain('Acme')
  })

  // task-3-brief.md: "the reset/verification URL has to be present and
  // usable in the text part, not only as an HTML anchor" — a text-only
  // client renders no markup, so the raw, clickable URL must appear as
  // literal text.
  it('the verification URL is present and usable (unescaped) in the plain-text part', () => {
    const rendered = renderEmailVerificationTemplate(validVariables)
    expect(rendered.text).toContain(validVariables.verificationUrl)
  })

  it('the verification URL appears in the HTML part as a real href', () => {
    const rendered = renderEmailVerificationTemplate(validVariables)
    expect(rendered.html).toContain(`href="${validVariables.verificationUrl}"`)
  })

  // Load-bearing: proves escaping through the PUBLIC render function, on
  // real output, with a payload that would actually execute if unescaped —
  // not merely one containing an angle bracket, and not a direct call to
  // escapeHtmlForEmail in isolation (task-3-brief.md's addendum, verbatim).
  describe('escaping', () => {
    it('escapes a script-executing payload in a text-node position (firstName) in html, but leaves text unescaped', () => {
      const payload = '<img src=x onerror=alert(1)>'
      const rendered = renderEmailVerificationTemplate({ ...validVariables, firstName: payload })

      // The raw, dangerous markup must not survive into the HTML part in
      // any form that a mail client's HTML renderer would execute.
      expect(rendered.html).not.toContain(payload)
      expect(rendered.html).not.toContain('<img')
      expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')

      // The plain-text part is not HTML, so it must NOT be escaped — a
      // recipient reading it in a text client should see the real value,
      // not HTML entities. This is what stops a lazy "escape everything
      // everywhere" implementation from passing.
      expect(rendered.text).toContain(payload)
    })

    it('escapes a quote-breakout payload in an attribute position (verificationUrl)', () => {
      const payload = 'https://example.test/verify?token=abc" onmouseover="alert(1)'
      const rendered = renderEmailVerificationTemplate({
        ...validVariables,
        verificationUrl: payload,
      })

      // The raw href attribute must never let the payload's own quote close
      // the attribute early and inject a new one.
      expect(rendered.html).not.toContain(`href="${payload}"`)
      expect(rendered.html).not.toContain('" onmouseover="alert(1)')
      expect(rendered.html).toContain('&quot; onmouseover=&quot;alert(1)')

      // The plain-text part carries the real, working URL — a text client
      // has no attribute context to break out of.
      expect(rendered.text).toContain(payload)
    })
  })

  describe('missing variables', () => {
    it('throws, naming the variable, when a required field is explicitly undefined', () => {
      expect(() =>
        renderEmailVerificationTemplate({
          ...validVariables,
          firstName: undefined as unknown as string,
        })
      ).toThrow(/firstName/)
    })

    it('throws, naming the variable, when a required field is omitted entirely', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling destructuring to build an object missing this key; the binding itself is intentionally unused
      const { firstName: _firstName, ...withoutFirstName } = validVariables
      expect(() =>
        renderEmailVerificationTemplate(withoutFirstName as EmailVerificationVariables)
      ).toThrow(/firstName/)
    })
  })

  // task-3-brief.md: "No token may appear in a subject line." verificationUrl
  // is the one variable in this template that could carry a token.
  it('never includes the verification URL in the subject', () => {
    const uniqueToken = 'verify-token-should-never-reach-a-subject-line'
    const rendered = renderEmailVerificationTemplate({
      ...validVariables,
      verificationUrl: `https://example.test/verify?token=${uniqueToken}`,
    })
    expect(rendered.subject).not.toContain(uniqueToken)
  })
})
