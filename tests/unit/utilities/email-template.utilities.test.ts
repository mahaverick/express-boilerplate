/**
 * @file Pure rendering helpers — no database, no container, no I/O — so
 * this lives under tests/unit/, not tests/integration/.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
} from '@/utilities/email-template.utilities'

describe('escapeHtmlForEmail', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtmlForEmail(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  it('does not double-escape — a single pass, not sequential replacements', () => {
    // A naive `.replaceAll('<', '&lt;').replaceAll('&', '&amp;')` (wrong order) would turn the entity this function just produced into `&amp;lt;`. This value exercises exactly that: the input's own `&` must survive as `&amp;`, not become part of a re-escaped entity.
    expect(escapeHtmlForEmail('<script>')).toBe('&lt;script&gt;')
    expect(escapeHtmlForEmail('a & b')).toBe('a &amp; b')
  })

  it('leaves a string with nothing to escape unchanged', () => {
    expect(escapeHtmlForEmail('plain text, no markup')).toBe('plain text, no markup')
  })

  it('neutralizes a value that would actually execute if left unescaped', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const escaped = escapeHtmlForEmail(payload)
    expect(escaped).not.toContain('<img')
    expect(escaped).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('requireEmailVariables', () => {
  const templateKey: EmailTemplateKey = 'sign_in_link'

  it('returns the object unchanged when every required name is a real string', () => {
    const variables = { firstName: 'Ada', signInUrl: 'https://example.test/auth/link' }
    expect(requireEmailVariables(variables, ['firstName', 'signInUrl'], templateKey)).toBe(
      variables
    )
  })

  it('throws, naming the variable, when a required value is present but undefined', () => {
    const variables = {
      firstName: undefined as unknown as string,
      signInUrl: 'https://example.test/auth/link',
    }
    expect(() => requireEmailVariables(variables, ['firstName', 'signInUrl'], templateKey)).toThrow(
      /firstName/
    )
  })

  /**
   * A key omitted entirely (not merely set to undefined) must be
   * caught. An Object.entries-based guard would never see this key at
   * all, since it never appears among the object's own entries — this
   * is the case that distinguishes a real guard from one that only
   * looks like it works.
   */
  it('throws, naming the variable, when a required key is absent from the object entirely', () => {
    const variables = { signInUrl: 'https://example.test/auth/link' } as unknown as {
      firstName: string
      signInUrl: string
    }
    expect(() => requireEmailVariables(variables, ['firstName', 'signInUrl'], templateKey)).toThrow(
      /firstName/
    )
  })

  it('names the template key in the thrown message', () => {
    const variables = { firstName: undefined as unknown as string }
    expect(() => requireEmailVariables(variables, ['firstName'], 'step_up_link')).toThrow(
      /step_up_link/
    )
  })

  it('reports the first missing name when more than one is missing', () => {
    const variables = {} as unknown as { firstName: string; signInUrl: string }
    expect(() => requireEmailVariables(variables, ['firstName', 'signInUrl'], templateKey)).toThrow(
      /firstName/
    )
  })
})

describe('EmailTemplateKey', () => {
  /**
   * Wrapped in an object (rather than a bare `const invalid:
   * EmailTemplateKey = ...`) so the property below is contextually
   * typed to the union, not narrowed by control flow to the one literal
   * it happens to hold — a bare const's narrowed type would make the
   * assertion below statically always-true
   * (sonarjs/no-trivial-assertions), a test that cannot fail.
   */
  it('a template key outside EMAIL_TEMPLATE_KEYS is a compile error', () => {
    const wrapper: { templateKey: EmailTemplateKey } = {
      // @ts-expect-error — EmailTemplateKey is closed to the literals in EMAIL_TEMPLATE_KEYS; a typo (hyphen instead of underscore) must fail to compile, not silently produce a key nothing ever renders under.
      templateKey: 'sign-in-link',
    }
    // A real assertion, not a throwaway — see tests/unit/database/models/user-token.model.test.ts's own comment on why the compile-time check needs one genuine read of the value.
    expect(wrapper.templateKey).toBe('sign-in-link')
  })
})
