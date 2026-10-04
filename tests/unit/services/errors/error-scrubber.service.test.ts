/**
 * @file scrubText against the shared vectors (tests/fixtures/error-scrub-vectors.json),
 * which the frontends copy byte for byte, plus the properties no single
 * vector shows: idempotence, the length cap and the bounded scan.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_VALUE_MAX } from '@/constants/error-tracking.constants'
import { scrubText } from '@/services/errors/error-scrubber.service'

interface ScrubVector {
  rule: string
  input: string
  expected: string
}

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/error-scrub-vectors.json')
const vectors = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ScrubVector[]

describe('scrubText vectors', () => {
  it.each(vectors.map((vector) => [vector.rule, vector.input, vector.expected]))(
    '%s: %s',
    (_rule, input, expected) => {
      expect(scrubText(input)).toBe(expected)
    }
  )

  it('covers every rule', () => {
    expect(new Set(vectors.map((vector) => vector.rule))).toEqual(
      new Set([
        'postgres',
        'query',
        'jwt',
        'bearer',
        'posthog-key',
        'email',
        'secret',
        'path',
        'cap',
      ])
    )
  })

  it('gives the same text when applied twice', () => {
    for (const { input } of vectors) {
      const once = scrubText(input)
      expect(scrubText(once)).toBe(once)
    }
  })
})

describe('scrubText', () => {
  it('cuts a long text to the cap, marker included', () => {
    const scrubbed = scrubText('word '.repeat(400))
    expect(scrubbed).toHaveLength(ERROR_VALUE_MAX)
    expect(scrubbed.endsWith('…[truncated]')).toBe(true)
  })

  it('keeps a text of exactly the cap whole', () => {
    const text = 'a b '.repeat(ERROR_VALUE_MAX / 4)
    expect(scrubText(text)).toBe(text)
  })

  it('never keeps half of a secret cut at the scan limit', () => {
    // The long run shrinks to [secret], pulling the hex that straddles the 4096th character into view.
    const text = `${'A'.repeat(3600)} ${'x '.repeat(240)}${'ab'.repeat(20)} tail`
    expect(text.indexOf('abab')).toBeLessThan(4 * ERROR_VALUE_MAX)
    expect(text.lastIndexOf('abab')).toBeGreaterThan(4 * ERROR_VALUE_MAX)
    const scrubbed = scrubText(text)
    expect(scrubbed.startsWith('[secret] x x')).toBe(true)
    expect(scrubbed).not.toContain('abab')
    expect(scrubbed.endsWith('…[truncated]')).toBe(true)
  })

  it('returns quickly on a long run with no @', () => {
    const started = performance.now()
    scrubText('a'.repeat(1_000_000))
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('scrubs a secret that appears after replacements shortened the text', () => {
    const jwt = 'eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl'
    expect(scrubText(`${jwt} jane@example.com`)).toBe('[jwt] [email]')
  })
})
