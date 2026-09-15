// tests/unit/templates/email/registration-attempt.template.test.ts
//
// Pure rendering — no database, no container, no I/O — so this lives under
// tests/unit/, not tests/integration/ (CLAUDE.md).
import { describe, expect, it } from 'vitest'
import {
  REGISTRATION_ATTEMPT_TEMPLATE_KEY,
  renderRegistrationAttemptTemplate,
  type RegistrationAttemptVariables,
} from '@/templates/email/registration-attempt.template'

const validVariables: RegistrationAttemptVariables = {
  firstName: 'Grace',
  appName: 'Acme',
}

describe('renderRegistrationAttemptTemplate', () => {
  it('reports its own template key', () => {
    expect(renderRegistrationAttemptTemplate(validVariables).templateKey).toBe(
      REGISTRATION_ATTEMPT_TEMPLATE_KEY
    )
  })

  it('a rendered template contains the interpolated values, in both parts', () => {
    const rendered = renderRegistrationAttemptTemplate(validVariables)
    expect(rendered.text).toContain('Grace')
    expect(rendered.text).toContain('Acme')
    expect(rendered.html).toContain('Grace')
    expect(rendered.html).toContain('Acme')
  })

  it('escapes a script-executing payload in html, but leaves text unescaped', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const rendered = renderRegistrationAttemptTemplate({ ...validVariables, firstName: payload })

    expect(rendered.html).not.toContain(payload)
    expect(rendered.html).not.toContain('<img')
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')

    expect(rendered.text).toContain(payload)
  })

  describe('missing variables', () => {
    it('throws, naming the variable, when a required field is explicitly undefined', () => {
      expect(() =>
        renderRegistrationAttemptTemplate({
          ...validVariables,
          firstName: undefined as unknown as string,
        })
      ).toThrow(/firstName/)
    })

    it('throws, naming the variable, when a required field is omitted entirely', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling destructuring to build an object missing this key; the binding itself is intentionally unused
      const { firstName: _firstName, ...withoutFirstName } = validVariables
      expect(() =>
        renderRegistrationAttemptTemplate(withoutFirstName as RegistrationAttemptVariables)
      ).toThrow(/firstName/)
    })
  })

  // This template carries no token or URL at all — see its own header
  // comment — so "no token in the subject" holds by construction. Pinned
  // here anyway: the subject must never grow a link/URL later without this
  // test being revisited.
  it('the subject contains no URL', () => {
    const rendered = renderRegistrationAttemptTemplate(validVariables)
    expect(rendered.subject).not.toMatch(/https?:\/\//)
  })
})
