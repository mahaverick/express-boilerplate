/**
 * @file The fixed-seed slice of the scrubber's differential gate
 * (tests/helpers/scrub-gate.ts), which needs no git history: on 2000
 * generated texts, no window of a planted secret that the pinned baseline hid
 * is in view, and no text the baseline scrubbed stably changes on a second
 * pass. Plus the gate's own measures, proven against deliberately weakened
 * scrubbers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scrubText } from '@/services/errors/error-scrubber.service'
import { corpusCase, huntCase } from '../../../helpers/scrub-gate-generators'
import { compareCase, visibleWindows } from '../../../helpers/scrub-gate-metric'

/**
 * The fixed-seed slice of the gate corpus, stored with the known leaks of the
 * baseline scrubber it is compared against, so the unit suite can run the gate
 * without git history. `allowed` maps a case index to the planted values (by
 * position) the baseline leaves partly in view, each with the windows
 * (`visibleWindows`) it shows.
 */
interface Slice {
  seed: number
  count: number
  baseline: string
  allowed: Record<string, Record<string, string[]>>
  unstable: number[]
}

const slicePath = path.resolve(process.cwd(), 'tests/fixtures/error-scrub-gate-slice.json')
const slice = JSON.parse(fs.readFileSync(slicePath, 'utf8')) as Slice

/**
 * The scrubber fed every `token` misspelt, so the token key rule never fires.
 */
function weakened(value: string): string {
  return scrubText(value.replaceAll(/token/gi, 'toke_'))
}

/**
 * The slice's cases in which `scrub` leaves in view a window of a planted
 * value that the baseline hid. Each is listed as `index: output`, once per
 * value with such a window.
 */
function sliceExposures(scrub: (value: string) => string): string[] {
  const exposed: string[] = []
  for (let index = 0; index < slice.count; index += 1) {
    const testCase = corpusCase(slice.seed, index)
    const output = scrub(testCase.input)
    for (const [at, value] of testCase.planted.entries()) {
      const allowed = new Set(slice.allowed[index]?.[at])
      if (visibleWindows(output, value).some((window) => !allowed.has(window)))
        exposed.push(`${index}: ${output}`)
    }
  }
  return exposed
}

/**
 * The first slice case with a planted value the baseline shows only part of,
 * and a window of that value the baseline hid.
 */
function halfHiddenCase(): { index: string; input: string; hidden: string } | undefined {
  for (const [index, values] of Object.entries(slice.allowed)) {
    const testCase = corpusCase(slice.seed, Number(index))
    for (const [at, shown] of Object.entries(values)) {
      const value = testCase.planted[Number(at)] ?? ''
      const hidden = visibleWindows(value, value).find((window) => !shown.includes(window))
      if (hidden !== undefined) return { index, input: testCase.input, hidden }
    }
  }
  return undefined
}

describe('scrubber gate slice', () => {
  it('keeps every planted secret the baseline hid out of view', () => {
    expect(sliceExposures(scrubText)).toEqual([])
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

  it('counts no exposure when the candidate writes Bearer [token] where the baseline kept a lowercase bearer', () => {
    expect(compareCase([], 'x bearer [redacted]', 'x Bearer [token]').exposedAlnum).toBe(0)
  })

  it('counts a lowercase bearer the candidate keeps where the baseline wrote Bearer [token]', () => {
    expect(compareCase([], 'x Bearer [token]', 'x bearer [token]').exposedAlnum).toBeGreaterThan(0)
  })

  it('counts a planted value next to Bearer [token] as exposed', () => {
    const comparison = compareCase(
      ['zqS7abcdef12'],
      'x Bearer [token][redacted]',
      'x Bearer [token]zqS7abcdef12'
    )
    expect(comparison.exposedWindows.length).toBeGreaterThan(0)
    expect(comparison.exposedAlnum).toBe(12)
  })

  it('counts the text a candidate removes that the baseline kept as over-redaction', () => {
    expect(compareCase([], 'GET /a failed', 'GET [redacted] failed').overRedacted).toBe(2)
  })

  it('sees a scrubber that shows one more window of a value the baseline half-hid', () => {
    // Proves the slice compares window by window: the baseline already shows part of this value, so a check per value would let the extra window through.
    const half = halfHiddenCase()
    expect(half).toBeDefined()
    const { index, input, hidden } = half ?? { index: '', input: '', hidden: '' }
    /**
     * The scrubber, plus the hidden window on the half-hidden case.
     * @param value - The text.
     * @returns The scrubbed text.
     */
    const leaky = (value: string): string =>
      value === input ? `${scrubText(value)} ${hidden}` : scrubText(value)
    expect(sliceExposures(leaky)).toEqual([`${index}: ${leaky(input)}`])
  })

  it('sees a scrubber that misses the token key on the slice', () => {
    // Proves the slice check is not vacuous: the same scrubber fed `toke_` for every `token` must leak.
    expect(sliceExposures(weakened)).not.toEqual([])
  })
})
