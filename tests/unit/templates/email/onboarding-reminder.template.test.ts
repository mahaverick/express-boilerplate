/**
 * @file Pure rendering — no database, no container, no I/O — so this
 * lives under tests/unit/, not tests/integration/.
 */
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_REMINDER_TEMPLATE_KEY,
  renderOnboardingReminderTemplate,
  type OnboardingReminderVariables,
} from '@/templates/email/onboarding-reminder.template'

const validVariables: OnboardingReminderVariables = {
  tenantName: 'Acme Rockets',
  appName: 'Acme',
  nextStep: 'Invite a teammate',
  overviewLink: 'https://app.example.test/tenants/acme-rockets',
}

describe('renderOnboardingReminderTemplate', () => {
  it('reports its own template key', () => {
    expect(renderOnboardingReminderTemplate(validVariables).templateKey).toBe(
      ONBOARDING_REMINDER_TEMPLATE_KEY
    )
  })

  it('carries the tenant, the next step and the overview link in both parts', () => {
    const rendered = renderOnboardingReminderTemplate(validVariables)
    for (const part of [rendered.text, rendered.html]) {
      expect(part).toContain('Acme Rockets')
      expect(part).toContain('Invite a teammate')
      expect(part).toContain('https://app.example.test/tenants/acme-rockets')
    }
    expect(rendered.html).toContain('<a href="https://app.example.test/tenants/acme-rockets">')
  })

  it('keeps the user-chosen tenant name out of the subject', () => {
    const rendered = renderOnboardingReminderTemplate(validVariables)
    expect(rendered.subject).toBe('Finish getting started on Acme')
    expect(rendered.subject).not.toContain('Acme Rockets')
    expect(rendered.subject).not.toMatch(/https?:\/\//)
  })

  it('escapes a script-executing payload in html, but leaves text unescaped', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const rendered = renderOnboardingReminderTemplate({ ...validVariables, tenantName: payload })

    expect(rendered.html).not.toContain(payload)
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(rendered.text).toContain(payload)
  })

  it('escapes a quote in the link, so it cannot leave the href attribute', () => {
    const rendered = renderOnboardingReminderTemplate({
      ...validVariables,
      overviewLink: 'https://app.example.test/tenants/x" onclick="alert(1)',
    })
    expect(rendered.html).not.toContain('" onclick="')
    expect(rendered.html).toContain('&quot; onclick=&quot;')
  })

  it.each(['tenantName', 'appName', 'nextStep', 'overviewLink'] as const)(
    'throws, naming %s, when it is missing',
    (name) => {
      const variables = { ...validVariables, [name]: undefined as unknown as string }
      expect(() => renderOnboardingReminderTemplate(variables)).toThrow(new RegExp(name))
    }
  )
})
