// tests/unit/utilities/email-template.utilities.test.ts
//
// Pure rendering helpers — no database, no container, no I/O — so this
// lives under tests/unit/, not tests/integration/ (CLAUDE.md).
import { describe, expect, it } from 'vitest'
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
    // A naive `.replaceAll('<', '&lt;').replaceAll('&', '&amp;')` (wrong
    // order) would turn the entity this function just produced into
    // `&amp;lt;`. This value exercises exactly that: the input's own `&`
    // must survive as `&amp;`, not become part of a re-escaped entity.
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
  const templateKey: EmailTemplateKey = 'password_reset'

  it('returns the object unchanged when every required name is a real string', () => {
    const variables = { firstName: 'Ada', resetUrl: 'https://example.test/reset' }
    expect(requireEmailVariables(variables, ['firstName', 'resetUrl'], templateKey)).toBe(variables)
  })

  it('throws, naming the variable, when a required value is present but undefined', () => {
    const variables = {
      firstName: undefined as unknown as string,
      resetUrl: 'https://example.test/reset',
    }
    expect(() => requireEmailVariables(variables, ['firstName', 'resetUrl'], templateKey)).toThrow(
      /firstName/
    )
  })

  // The canonical failure task-3-brief.md names: a key OMITTED entirely
  // (not merely set to undefined) must still be caught. An
  // Object.entries-based guard would never see this key at all, since it
  // never appears among the object's own entries — this is the case that
  // distinguishes a real guard from one that only looks like it works.
  it('throws, naming the variable, when a required key is absent from the object entirely', () => {
    const variables = { resetUrl: 'https://example.test/reset' } as unknown as {
      firstName: string
      resetUrl: string
    }
    expect(() => requireEmailVariables(variables, ['firstName', 'resetUrl'], templateKey)).toThrow(
      /firstName/
    )
  })

  it('names the template key in the thrown message', () => {
    const variables = { firstName: undefined as unknown as string }
    expect(() => requireEmailVariables(variables, ['firstName'], 'email_verification')).toThrow(
      /email_verification/
    )
  })

  it('reports the first missing name when more than one is missing', () => {
    const variables = {} as unknown as { firstName: string; resetUrl: string }
    expect(() => requireEmailVariables(variables, ['firstName', 'resetUrl'], templateKey)).toThrow(
      /firstName/
    )
  })
})

describe('EmailTemplateKey', () => {
  it('a template key outside EMAIL_TEMPLATE_KEYS is a compile error', () => {
    // Wrapped in an object (rather than a bare `const invalid:
    // EmailTemplateKey = ...`) so the property below is contextually typed
    // to the UNION, not narrowed by control flow to the one literal it
    // happens to hold — a bare const's narrowed type made the assertion
    // below statically always-true (sonarjs/no-trivial-assertions), which
    // is exactly the "test that cannot fail" shape this project's own
    // history warns against.
    const wrapper: { templateKey: EmailTemplateKey } = {
      // @ts-expect-error — EmailTemplateKey is closed to the three literals
      // in EMAIL_TEMPLATE_KEYS; a typo (hyphen instead of underscore) must
      // fail to compile, not silently produce a key nothing ever renders
      // under. If this stops erroring, the union has widened back to
      // `string` and `pnpm lint`'s type-checking pass reports "Unused
      // '@ts-expect-error' directive" — a real, red gate, not merely a
      // runtime assertion.
      templateKey: 'password-reset',
    }
    // A real assertion, not a throwaway — see
    // tests/unit/database/models/user-token.model.test.ts's own comment on
    // why the compile-time check needs one genuine read of the value.
    expect(wrapper.templateKey).toBe('password-reset')
  })
})
