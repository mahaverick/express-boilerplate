/**
 * @file Pure rendering — no database, no container, no I/O — so this
 * lives under tests/unit/, not tests/integration/.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_SETUP_TEMPLATE_KEY,
  renderAccountSetupTemplate,
  type AccountSetupVariables,
} from '@/templates/email/account-setup.template'

const validVariables: AccountSetupVariables = {
  firstName: 'Grace',
  setupUrl: 'https://example.test/reset-password?token=abc123',
  appName: 'Acme',
}

describe('renderAccountSetupTemplate', () => {
  it('reports its own template key', () => {
    expect(ACCOUNT_SETUP_TEMPLATE_KEY).toBe('account_setup')
    expect(renderAccountSetupTemplate(validVariables).templateKey).toBe(ACCOUNT_SETUP_TEMPLATE_KEY)
  })

  it('carries the name, app and link in both parts', () => {
    const rendered = renderAccountSetupTemplate(validVariables)
    expect(rendered.text).toContain('Grace')
    expect(rendered.text).toContain('Acme')
    expect(rendered.text).toContain(validVariables.setupUrl)
    expect(rendered.html).toContain('Grace')
    expect(rendered.html).toContain(`href="${validVariables.setupUrl}"`)
  })

  it('says the account was created for them, so an unexpected mail makes sense', () => {
    const rendered = renderAccountSetupTemplate(validVariables)
    expect(rendered.subject).toBe('Your Acme account is ready — set your password')
    expect(rendered.text).toMatch(/The Acme team has created an account for you/)
  })

  it('escapes HTML in firstName and a quote breakout in setupUrl', () => {
    const rendered = renderAccountSetupTemplate({
      ...validVariables,
      firstName: '<img src=x onerror=alert(1)>',
      setupUrl: 'https://example.test/?token=x" onmouseover="alert(1)',
    })
    expect(rendered.html).not.toContain('<img')
    expect(rendered.html).not.toContain('" onmouseover="alert(1)')
    expect(rendered.text).toContain('<img src=x onerror=alert(1)>')
  })

  it('throws, naming the variable, when setupUrl is missing', () => {
    expect(() =>
      renderAccountSetupTemplate({ ...validVariables, setupUrl: undefined as unknown as string })
    ).toThrow(/setupUrl/)
  })

  it('never puts the link, which holds a token, in the subject', () => {
    const token = 'setup-token-should-never-reach-a-subject-line'
    const rendered = renderAccountSetupTemplate({
      ...validVariables,
      setupUrl: `https://example.test/reset-password?token=${token}`,
    })
    expect(rendered.subject).not.toContain(token)
  })
})
