/**
 * @file The scrubber gate's measures. A value exposure is a planted secret
 * that a candidate scrubber leaves in view, in part, where a baseline
 * scrubber hid it on the same input; that is the gate. The broad net counts
 * letters and digits the candidate keeps that the baseline removed, planted
 * or not, so an unplanted leak still shows. Over-redaction is the reverse.
 */

/**
 * The length of the windows a planted value is checked in: a value counts
 * as in view when any run of this many of its characters is.
 */
const WINDOW = 6

/**
 * Every placeholder a scrubber writes, the truncation marker, and URL
 * escapes (`%22`), whose digits are encoding, not content.
 */
const PLACEHOLDER_PATTERN =
  /\[(?:redacted|value|credentials|query|fragment|token|jwt|posthog-key|email|secret|ip|phone)\]|…\[truncated\]|%[\dA-Fa-f]{2}/g

/**
 * The windows of a planted value present in a text.
 * @param text - A scrubber's output.
 * @param value - A planted value.
 * @returns The windows of the value found in the text.
 */
export function visibleWindows(text: string, value: string): string[] {
  if (value.length <= WINDOW) return text.includes(value) ? [value] : []
  const found: string[] = []
  for (let start = 0; start + WINDOW <= value.length; start += 1) {
    const window = value.slice(start, start + WINDOW)
    if (text.includes(window)) found.push(window)
  }
  return found
}

/**
 * Count each character of a text left after its placeholders are removed.
 * @param text - A scrubber's output.
 * @returns How many times each character occurs.
 */
function keptCharacters(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const character of text.replaceAll(PLACEHOLDER_PATTERN, '')) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
  }
  return counts
}

/**
 * How one input compares under the two scrubbers.
 */
export interface CaseComparison {
  /**
  Planted windows the candidate shows and the baseline hid.
   */
  exposedWindows: string[]
  /**
  Letters and digits the candidate keeps more of than the baseline.
   */
  exposedAlnum: number
  /**
  Other characters the candidate keeps more of than the baseline.
   */
  exposedOther: number
  /**
  Characters the baseline keeps more of than the candidate.
   */
  overRedacted: number
}

/**
 * The windows of planted values a candidate shows and a baseline hid.
 * @param planted - The input's planted values.
 * @param baseline - The baseline scrubber's output.
 * @param candidate - The candidate scrubber's output.
 * @returns The newly visible windows.
 */
function exposedWindows(planted: readonly string[], baseline: string, candidate: string): string[] {
  const exposed: string[] = []
  for (const value of planted) {
    const before = new Set(visibleWindows(baseline, value))
    for (const window of visibleWindows(candidate, value)) {
      if (!before.has(window)) exposed.push(window)
    }
  }
  return exposed
}

/**
 * Compare a candidate's output with a baseline's on one input.
 * @param planted - The input's planted values.
 * @param baseline - The baseline scrubber's output.
 * @param candidate - The candidate scrubber's output.
 * @returns The exposures and over-redaction.
 */
export function compareCase(
  planted: readonly string[],
  baseline: string,
  candidate: string
): CaseComparison {
  const comparison: CaseComparison = {
    exposedWindows: [],
    exposedAlnum: 0,
    exposedOther: 0,
    overRedacted: 0,
  }
  if (baseline === candidate) return comparison
  comparison.exposedWindows = exposedWindows(planted, baseline, candidate)
  const kept = keptCharacters(baseline)
  const keptNow = keptCharacters(candidate)
  for (const [character, count] of keptNow) {
    const extra = count - (kept.get(character) ?? 0)
    if (extra <= 0) continue
    if (/[\p{L}\p{N}]/u.test(character)) comparison.exposedAlnum += extra
    else comparison.exposedOther += extra
  }
  for (const [character, count] of kept) {
    comparison.overRedacted += Math.max(0, count - (keptNow.get(character) ?? 0))
  }
  return comparison
}
