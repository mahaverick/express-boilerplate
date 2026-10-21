/**
 * @file Unit tests for `withUtm`: the four parameters, the untouched query and fragment, and the replaced duplicates.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  UTM_CONTENTS,
  UTM_MEDIUMS,
  UTM_SOURCES,
  withEmailUtm,
  withUtm,
  type UtmParams,
} from '@/utilities/utm.utilities'

/**
 * A fixed UTM set for the tests.
 */
const UTM: UtmParams = {
  source: 'email',
  medium: 'email',
  campaign: 'sign_in_link',
  content: 'text_link',
}

/**
 * The UTM query a call to `withUtm(…, UTM)` appends.
 */
const UTM_QUERY =
  'utm_source=email&utm_medium=email&utm_campaign=sign_in_link&utm_content=text_link'

describe('withUtm', () => {
  it('adds the four parameters to a link with no query', () => {
    expect(withUtm('https://app.example.test/page', UTM)).toBe(
      `https://app.example.test/page?${UTM_QUERY}`
    )
  })

  it('keeps token, email and redirect byte for byte', () => {
    const query =
      'token=AbC_-123&email=person%2Btag%40example.test&redirect=%2Ft%2Facme%3Ftab%3D2%23x'
    expect(withUtm(`https://app.example.test/auth/link?${query}`, UTM)).toBe(
      `https://app.example.test/auth/link?${query}&${UTM_QUERY}`
    )
  })

  it('keeps a query that is not in form encoding as written', () => {
    expect(withUtm('https://app.example.test/p?a=%20b&c=d~e', UTM)).toBe(
      `https://app.example.test/p?a=%20b&c=d~e&${UTM_QUERY}`
    )
  })

  it('keeps the fragment after the query', () => {
    expect(withUtm('https://app.example.test/p?a=1#frag', UTM)).toBe(
      `https://app.example.test/p?a=1&${UTM_QUERY}#frag`
    )
  })

  it('overwrites an existing utm value rather than repeating it', () => {
    const out = new URL(
      withUtm('https://app.example.test/p?utm_source=old&a=1&utm_content=old', UTM)
    )
    expect(out.searchParams.getAll('utm_source')).toEqual(['email'])
    expect(out.searchParams.getAll('utm_content')).toEqual(['text_link'])
    expect(out.searchParams.get('a')).toBe('1')
  })

  it('leaves an empty token value in place', () => {
    expect(withUtm('https://app.example.test/p?token=', UTM)).toBe(
      `https://app.example.test/p?token=&${UTM_QUERY}`
    )
  })

  it('throws for a relative URL', () => {
    expect(() => withUtm('/relative', UTM)).toThrow(TypeError)
  })
})

describe('withEmailUtm', () => {
  it('sets email source and medium, the template key as campaign, and the content', () => {
    const out = new URL(withEmailUtm('https://app.example.test/p', 'welcome', 'primary_button'))
    expect(Object.fromEntries(out.searchParams)).toEqual({
      utm_source: 'email',
      utm_medium: 'email',
      utm_campaign: 'welcome',
      utm_content: 'primary_button',
    })
  })
})

describe('UTM value lists', () => {
  it('hold the agreed values', () => {
    expect(UTM_SOURCES).toEqual(['email', 'in_app'])
    expect(UTM_MEDIUMS).toEqual(['email', 'notification', 'banner'])
    expect(UTM_CONTENTS).toEqual([
      'primary_button',
      'text_link',
      'footer_settings',
      'footer_unsubscribe',
    ])
  })
})
