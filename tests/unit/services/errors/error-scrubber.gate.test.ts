/**
 * @file The fixed-seed slice of the scrubber's differential gate
 * (tests/helpers/scrub-gate.ts), which needs no git history: on 2000
 * generated texts, no planted secret the pinned baseline hid is in view, and
 * no text the baseline scrubbed stably changes on a second pass. Plus the
 * gate's own measures, proven against a deliberately weakened scrubber.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubText } from '@/services/errors/error-scrubber.service'
import { corpusCase, huntCase } from '../../../helpers/scrub-gate-generators'
import { compareCase, visibleWindows } from '../../../helpers/scrub-gate-metric'

interface Slice {
  seed: number
  count: number
  baseline: string
  allowed: Record<string, number[]>
  unstable: number[]
}

const slicePath = path.resolve(process.cwd(), 'tests/fixtures/error-scrub-gate-slice.json')
const slice = JSON.parse(fs.readFileSync(slicePath, 'utf8')) as Slice

/**
 * The scrubber fed every `token` misspelt, so the token key rule never fires.
 * @param value - The text.
 * @returns The weakened scrub.
 */
function weakened(value: string): string {
  return scrubText(value.replaceAll(/token/gi, 'toke_'))
}

describe('scrubber gate slice', () => {
  it('keeps every planted secret the baseline hid out of view', () => {
    const exposed: string[] = []
    for (let index = 0; index < slice.count; index += 1) {
      const testCase = corpusCase(slice.seed, index)
      const allowed = new Set(slice.allowed[index])
      const output = scrubText(testCase.input)
      for (const [at, value] of testCase.planted.entries()) {
        if (!allowed.has(at) && visibleWindows(output, value).length > 0)
          exposed.push(`${index}: ${output}`)
      }
    }
    expect(exposed).toEqual([])
  })

  it('gives the same text twice wherever the baseline did', () => {
    const unstable = new Set(slice.unstable)
    const changed: number[] = []
    for (let index = 0; index < slice.count; index += 1) {
      const once = scrubText(corpusCase(slice.seed, index).input)
      if (!unstable.has(index) && scrubText(once) !== once) changed.push(index)
    }
    expect(changed).toEqual([])
  })
})

describe('scrubber gate measures', () => {
  it('builds the same case from the same seed and index', () => {
    expect(corpusCase(7, 11)).toEqual(corpusCase(7, 11))
    expect(huntCase(7, 11)).toEqual(huntCase(7, 11))
    expect(corpusCase(7, 11).input).not.toBe(corpusCase(7, 12).input)
  })

  it('counts a planted value the candidate shows and the baseline hid', () => {
    const comparison = compareCase(['zqS7abcdef12'], 'sent [redacted]', 'sent zqS7abcdef12')
    expect(comparison.exposedWindows.length).toBeGreaterThan(0)
    expect(comparison.exposedAlnum).toBe(12)
  })

  it('counts no exposure when the outputs only swap placeholders or encodings', () => {
    const comparison = compareCase(['zqS7abcdef12'], 'x=%[secret]%22', 'x=%22[redacted]%22')
    expect(comparison.exposedWindows).toEqual([])
    expect(comparison.exposedAlnum + comparison.exposedOther).toBe(0)
  })

  it('counts the text a candidate removes that the baseline kept as over-redaction', () => {
    expect(compareCase([], 'GET /a failed', 'GET [redacted] failed').overRedacted).toBe(2)
  })

  it('sees a scrubber that misses the token key on the slice', () => {
    // Proves the gate is not vacuous: the same scrubber fed `toke_` for every `token` must leak.
    let exposures = 0
    for (let index = 0; index < 500; index += 1) {
      const testCase = corpusCase(slice.seed, index)
      exposures += compareCase(
        testCase.planted,
        scrubText(testCase.input),
        weakened(testCase.input)
      ).exposedWindows.length
    }
    expect(exposures).toBeGreaterThan(0)
  })
})
