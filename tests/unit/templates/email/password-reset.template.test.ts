// tests/unit/templates/email/password-reset.template.test.ts
//
// Pure rendering — no database, no container, no I/O — so this lives under
// tests/unit/, not tests/integration/ (CLAUDE.md).
import { describe, expect, it } from 'vitest'
import {
  PASSWORD_RESET_TEMPLATE_KEY,
  renderPasswordResetTemplate,
  type PasswordResetVariables,
} from '@/templates/email/password-reset.template'

const validVariables: PasswordResetVariables = {
  firstName: 'Grace',
  resetUrl: 'https://example.test/reset?token=xyz789',
  appName: 'Acme',
}

describe('renderPasswordResetTemplate', () => {
  it('reports its own template key', () => {
    expect(renderPasswordResetTemplate(validVariables).templateKey).toBe(
      PASSWORD_RESET_TEMPLATE_KEY
    )
  })

  it('a rendered template contains the interpolated values, in both parts', () => {
    const rendered = renderPasswordResetTemplate(validVariables)
    expect(rendered.text).toContain('Grace')
    expect(rendered.text).toContain('Acme')
    expect(rendered.text).toContain(validVariables.resetUrl)
    expect(rendered.html).toContain('Grace')
    expect(rendered.html).toContain('Acme')
  })

  it('the reset URL is present and usable (unescaped) in the plain-text part', () => {
    const rendered = renderPasswordResetTemplate(validVariables)
    expect(rendered.text).toContain(validVariables.resetUrl)
  })

  it('the reset URL appears in the HTML part as a real href', () => {
    const rendered = renderPasswordResetTemplate(validVariables)
    expect(rendered.html).toContain(`href="${validVariables.resetUrl}"`)
  })

  describe('escaping', () => {
    it('escapes a script-executing payload in a text-node position (firstName) in html, but leaves text unescaped', () => {
      const payload = '<img src=x onerror=alert(1)>'
      const rendered = renderPasswordResetTemplate({ ...validVariables, firstName: payload })

      expect(rendered.html).not.toContain(payload)
      expect(rendered.html).not.toContain('<img')
      expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')

      expect(rendered.text).toContain(payload)
    })

    it('escapes a quote-breakout payload in an attribute position (resetUrl)', () => {
      const payload = 'https://example.test/reset?token=xyz" onmouseover="alert(1)'
      const rendered = renderPasswordResetTemplate({ ...validVariables, resetUrl: payload })

      expect(rendered.html).not.toContain(`href="${payload}"`)
      expect(rendered.html).not.toContain('" onmouseover="alert(1)')
      expect(rendered.html).toContain('&quot; onmouseover=&quot;alert(1)')

      expect(rendered.text).toContain(payload)
    })
  })

  describe('missing variables', () => {
    it('throws, naming the variable, when a required field is explicitly undefined', () => {
      expect(() =>
        renderPasswordResetTemplate({
          ...validVariables,
          firstName: undefined as unknown as string,
        })
      ).toThrow(/firstName/)
    })

    it('throws, naming the variable, when a required field is omitted entirely', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling destructuring to build an object missing this key; the binding itself is intentionally unused
      const { firstName: _firstName, ...withoutFirstName } = validVariables
      expect(() => renderPasswordResetTemplate(withoutFirstName as PasswordResetVariables)).toThrow(
        /firstName/
      )
    })
  })

  // task-3-brief.md: "No token may appear in a subject line." resetUrl is
  // the one variable in this template that carries the reset token — the
  // canonical case this rule exists for.
  it('never includes the reset URL in the subject', () => {
    const uniqueToken = 'reset-token-should-never-reach-a-subject-line'
    const rendered = renderPasswordResetTemplate({
      ...validVariables,
      resetUrl: `https://example.test/reset?token=${uniqueToken}`,
    })
    expect(rendered.subject).not.toContain(uniqueToken)
  })
})
