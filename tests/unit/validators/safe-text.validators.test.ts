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
    expect(safeText()('a\u{202E}b')).toBe(false)
    expect(safeText()('a\u{2066}b')).toBe(false)
  })

  it('rejects exactly the nine bidi embedding/override/isolate code points', () => {
    const bidi = [0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_66, 0x20_67, 0x20_68, 0x20_69]
    for (const codePoint of bidi) {
      expect(safeText()(`a${String.fromCodePoint(codePoint)}b`)).toBe(false)
    }
    for (const neighbour of [0x20_29, 0x20_2f, 0x20_65, 0x20_6a]) {
      expect(safeText()(`a${String.fromCodePoint(neighbour)}b`)).toBe(true)
    }
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
    expect(safeText({ multiline: true })('a\u{202E}b')).toBe(false)
  })

  it('accepts real names in any script, with direction marks, ZWJ emoji and combining accents', () => {
    for (const name of [
      'Ὀδυσσεύς',
      'محمد',
      'שָׁלוֹם\u{200F}',
      'Ali\u{200E}a',
      '👨\u{200D}👩\u{200D}👧',
      'Zoë',
    ]) {
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
