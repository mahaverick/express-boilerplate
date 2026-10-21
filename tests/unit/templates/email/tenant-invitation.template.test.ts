/**
 * @file Pure rendering: no database, no container, no I/O.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  renderTenantInvitationTemplate,
  type TenantInvitationVariables,
} from '@/templates/email/tenant-invitation.template'

const ACCEPT_URL = 'https://app.example.test/invitations/accept?token=abc123'

const validVariables: TenantInvitationVariables = {
  tenantName: 'Acme Inc',
  inviterName: 'Ada Lovelace',
  role: 'editor',
  acceptUrl: ACCEPT_URL,
  expiresInDays: '7',
  expiresAt: '15:42 UTC on 20 October 2026',
  appName: 'Boilerplate',
}

describe('renderTenantInvitationTemplate', () => {
  it('reports the tenant_invitation template key', () => {
    expect(renderTenantInvitationTemplate(validVariables).templateKey).toBe('tenant_invitation')
  })

  it('names the inviter, tenant, role and lifetime in both parts', () => {
    const rendered = renderTenantInvitationTemplate(validVariables)
    for (const part of [rendered.text, rendered.html]) {
      expect(part).toContain('Ada Lovelace invited you to join Acme Inc as editor.')
      expect(part).toContain('This link expires in 7 days, at 15:42 UTC on 20 October 2026.')
    }
  })

  it('carries the accept link in both parts', () => {
    const rendered = renderTenantInvitationTemplate(validVariables)
    expect(rendered.text).toContain(ACCEPT_URL)
    expect(rendered.html).toContain(`href="${ACCEPT_URL}"`)
  })

  it('labels the one button "Join <Tenant>"', () => {
    const rendered = renderTenantInvitationTemplate(validVariables)
    expect(rendered.html).toContain(`<a href="${ACCEPT_URL}">Join Acme Inc</a>`)
    expect(rendered.html.match(/<a /g)).toHaveLength(1)
    expect(rendered.text).toContain(`Join Acme Inc:\n\n${ACCEPT_URL}`)
  })

  it('keeps the link and the user-chosen names out of the subject', () => {
    const { subject } = renderTenantInvitationTemplate(validVariables)
    expect(subject).toBe('Join your team on Boilerplate')
    expect(subject).not.toContain('abc123')
    expect(subject).not.toContain('Acme Inc')
    expect(subject).not.toContain('Ada Lovelace')
  })

  it('asks a reader without an account for nothing beyond the click', () => {
    const rendered = renderTenantInvitationTemplate(validVariables)
    for (const part of [rendered.text, rendered.html]) {
      expect(part).not.toContain('account yet')
      expect(part).not.toContain('verify it')
    }
  })

  it('says "1 day" for a one-day lifetime', () => {
    const rendered = renderTenantInvitationTemplate({ ...validVariables, expiresInDays: '1' })
    expect(rendered.text).toContain('This link expires in 1 day, at 15:42 UTC on 20 October 2026.')
  })

  it.each(['tenantName', 'inviterName'] as const)(
    'escapes a markup payload in %s in the html part, not the text part',
    (field) => {
      const payload = '<img src=x onerror=alert(1)>'
      const rendered = renderTenantInvitationTemplate({ ...validVariables, [field]: payload })

      expect(rendered.html).not.toContain(payload)
      expect(rendered.html).not.toContain('<img')
      expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(rendered.text).toContain(payload)
    }
  )

  it('refuses to render without an accept link', () => {
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- rest-sibling destructuring drops the key under test
    const { acceptUrl, ...withoutUrl } = validVariables
    expect(() => renderTenantInvitationTemplate(withoutUrl as TenantInvitationVariables)).toThrow(
      /acceptUrl/
    )
  })
})
