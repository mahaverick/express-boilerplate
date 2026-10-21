import { describe, expect, it } from 'vite-plus/test'
import {
  appNameFor,
  buildInvitationAcceptUrl,
  frontendUrl,
} from '@/services/frontend-links.service'

/**
 * The UTM query an invitation link carries after its token.
 */
const INVITATION_UTM =
  'utm_source=email&utm_medium=email&utm_campaign=tenant_invitation&utm_content=primary_button'

describe('buildInvitationAcceptUrl', () => {
  it('points at the frontend accept page with the token as a query parameter', () => {
    const url = new URL(buildInvitationAcceptUrl('abc_123-XYZ', 'https://app.example.com'))

    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/invitations/accept')
    expect(url.searchParams.get('token')).toBe('abc_123-XYZ')
    expect(url.searchParams.get('utm_campaign')).toBe('tenant_invitation')
  })

  it('percent-encodes the token rather than concatenating it raw', () => {
    // The base is passed explicitly in every test here: a unit test must not depend on a validated env being loadable, and getEnv() throws when one is not.
    const url = new URL(buildInvitationAcceptUrl('a+b/c==', 'https://app.example.com'))

    expect(url.searchParams.get('token')).toBe('a+b/c==')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    expect(buildInvitationAcceptUrl('t', 'https://app.example.com/')).toBe(
      `https://app.example.com/invitations/accept?token=t&${INVITATION_UTM}`
    )
  })
})

describe('frontendUrl', () => {
  const web = 'https://app.example.com'
  const apex = 'https://admin.example.com'

  it('answers WEB_URL for web, whether or not APEX_URL is set', () => {
    expect(frontendUrl('web', { WEB_URL: web, APEX_URL: undefined })).toBe(web)
    expect(frontendUrl('web', { WEB_URL: web, APEX_URL: apex })).toBe(web)
  })

  it('answers APEX_URL for apex when it is set', () => {
    expect(frontendUrl('apex', { WEB_URL: web, APEX_URL: apex })).toBe(apex)
  })

  it('falls back to WEB_URL for apex when APEX_URL is unset', () => {
    expect(frontendUrl('apex', { WEB_URL: web, APEX_URL: undefined })).toBe(web)
  })

  it.each([
    ['https://admin.example.com/', 'https://admin.example.com/invitations/accept'],
    ['https://admin.example.com/apex', 'https://admin.example.com/apex/invitations/accept'],
    ['https://admin.example.com/apex/', 'https://admin.example.com/apex/invitations/accept'],
  ])('builds a clean link from APEX_URL %s', (configured, expected) => {
    const base = frontendUrl('apex', { WEB_URL: web, APEX_URL: configured })
    expect(buildInvitationAcceptUrl('t', base)).toBe(`${expected}?token=t&${INVITATION_UTM}`)
  })
})

describe('appNameFor', () => {
  const names = { APP_NAME: 'Express Boilerplate', APEX_APP_NAME: 'Apex' }

  it('names the customer app APP_NAME and Apex APEX_APP_NAME', () => {
    expect(appNameFor('web', names)).toBe('Express Boilerplate')
    expect(appNameFor('apex', names)).toBe('Apex')
  })
})
