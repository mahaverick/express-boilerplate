// tests/unit/validators/safe-text.validators.test.ts
import { describe, expect, it } from 'vitest'
import { normalizeMultilineText, safeText } from '@/validators/safe-text.validators'

describe('safeText', () => {
  it('rejects a Cc control character', () => {
    expect(safeText()('a\u{0}b')).toBe(false)
    expect(safeText()('a\u{1B}b')).toBe(false)
    expect(safeText()('a\u{85}b')).toBe(false)
  })

  it('rejects a bidi override/isolate character', () => {
    expect(safeText()('a‮b')).toBe(false)
    expect(safeText()('a⁦b')).toBe(false)
  })

  it('accepts plain text with accents or emoji', () => {
    expect(safeText()('Zoë 👋')).toBe(true)
  })

  it(String.raw`single-line mode rejects \n and \t too`, () => {
    expect(safeText()('a\nb')).toBe(false)
    expect(safeText()('a\tb')).toBe(false)
  })

  it(String.raw`multiline mode accepts \n and \t, still rejects other Cc characters`, () => {
    expect(safeText({ multiline: true })('a\nb\tc')).toBe(true)
    expect(safeText({ multiline: true })('a\u{0}b')).toBe(false)
  })

  it('multiline mode still rejects a bidi override', () => {
    expect(safeText({ multiline: true })('a‮b')).toBe(false)
  })

  it('accepts real names in any script, with direction marks, ZWJ emoji and combining accents', () => {
    for (const name of ['Ὀδυσσεύς', 'محمد', 'שָׁלוֹם‏', 'Ali‎a', '👨‍👩‍👧', 'Zoë']) {
      expect(safeText()(name)).toBe(true)
    }
  })
})

describe('normalizeMultilineText', () => {
  it('turns CRLF into LF', () => {
    expect(normalizeMultilineText('a\r\nb')).toBe('a\nb')
  })

  it('leaves a non-string value alone, for zod to reject on type', () => {
    expect(normalizeMultilineText(42)).toBe(42)
  })
})
