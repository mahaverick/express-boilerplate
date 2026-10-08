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

  it('rejects the nine bidi embedding/override/isolate code points, not their visible neighbours', () => {
    const bidi = [0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_66, 0x20_67, 0x20_68, 0x20_69]
    for (const codePoint of bidi) {
      expect(safeText()(`a${String.fromCodePoint(codePoint)}b`)).toBe(false)
    }
    for (const neighbour of [0x20_27, 0x20_2f, 0x20_5f]) {
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

  it('accepts real names in any script, with combining accents', () => {
    for (const name of ['Ὀδυσσεύς', 'محمد', 'שָׁלוֹם', 'Zoë', 'Ångström']) {
      expect(safeText()(name)).toBe(true)
    }
  })

  it('accepts a zero-width joiner or non-joiner inside a word or emoji sequence', () => {
    for (const name of [
      'می\u{200C}خواهم',
      'क\u{094D}\u{200D}ष',
      '👨\u{200D}👩\u{200D}👧',
      '👍🏽',
      '👩🏽\u{200D}💻',
      '🏳\u{FE0F}\u{200D}🌈',
    ]) {
      expect(safeText()(name)).toBe(true)
    }
  })

  it('refuses a direction mark inside a real name, or a joiner at a word edge', () => {
    for (const name of [
      'שָׁלוֹם\u{200F}',
      'Ali\u{200E}a',
      'abc\u{200E}def',
      'abc\u{200F}def',
      'abc\u{202E}def',
      '\u{200D}abc',
      'abc\u{200C}',
      'a \u{200C} b',
      'a\u{200D}\u{200D}b',
      '👨\u{200D}',
      'a\u{200D}.b',
    ]) {
      expect(safeText()(name)).toBe(false)
    }
  })

  it('multiline mode still refuses a zero-width space', () => {
    expect(safeText({ multiline: true })('line one\nAd\u{200B}min')).toBe(false)
  })
})

describe('safeText refuses invisible format characters', () => {
  it.each([
    ['ZERO WIDTH SPACE', 'Ad\u{200B}min'],
    ['ZERO WIDTH JOINER', 'Admin\u{200D}'],
    ['ZERO WIDTH NON-JOINER', '\u{200C}Admin'],
    ['LEFT-TO-RIGHT MARK', 'Admin\u{200E}'],
    ['RIGHT-TO-LEFT MARK', 'Admin\u{200F}'],
    ['ARABIC LETTER MARK', 'Admin\u{061C}'],
    ['LINE SEPARATOR', 'Ad\u{2028}min'],
    ['PARAGRAPH SEPARATOR', 'Ad\u{2029}min'],
    ['WORD JOINER', 'Ad\u{2060}min'],
    ['BYTE ORDER MARK', '\u{FEFF}Admin'],
  ])('%s', (_label, value) => {
    expect(safeText()(value)).toBe(false)
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
