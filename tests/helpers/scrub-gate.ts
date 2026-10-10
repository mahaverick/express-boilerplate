/**
 * @file The scrubber's differential gate, run by hand at review time:
 * `pnpm scrub:gate <mode> [options]`. It loads a baseline scrubber from a
 * pinned commit with `git show` (so no frozen copy is committed, and the
 * clone must have that commit) and compares the working tree's `scrubText`
 * with it on generated texts (tests/helpers/scrub-gate-generators.ts).
 *
 * Modes:
 * - `corpus`: cases 0 to count-1 of the fixed-seed corpus;
 * - `hunt`: mutated cases from a fresh or given seed, for a count or a time;
 * - `vectors`: each row of the shared fixture against its expectation;
 * - `replay`: one case, `--replay corpus:<seed>:<index>` or `hunt:<seed>:<index>`;
 * - `slice`: rewrites the unit suite's slice file from the baseline.
 *
 * Options: `--seed n`, `--count n`, `--seconds n`, `--baseline <sha>`,
 * `--candidate-sha <sha>` (compare two commits instead of the working
 * tree), `--samples n` (tests/helpers/scrub-gate-options.ts). The exit code
 * is 1 when a planted value or a letter or digit is newly exposed, a text the
 * baseline scrubbed stably changes on a second pass, no case ran, a fixture
 * row's output differs from its expectation or changes on a second pass, or
 * an option is malformed or not read by the mode.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { corpusCase, huntCase, type GateCase } from './scrub-gate-generators'
import { compareCase, visibleWindows } from './scrub-gate-metric'
import { CORPUS_SEED, parseOptions, type Options } from './scrub-gate-options'

/**
 * The scrubber's path in the repository.
 */
const SCRUBBER_PATH = 'src/services/errors/error-scrubber.service.ts'

/**
 * The slice the unit suite checks without git history.
 */
const SLICE_FILE = 'tests/fixtures/error-scrub-gate-slice.json'

/**
 * The import an older scrubber has, which the loader replaces with the cap.
 */
const CAP_IMPORT = /^import \{ ERROR_VALUE_MAX \} from '@\/constants\/error-tracking\.constants'$/m

/**
 * A scrubber under test.
 */
type Scrub = (value: string) => string

/**
 * Load the scrubber at a commit from a temporary file, its one `@/` import
 * (if any) replaced with the cap's value.
 * @param sha - The commit.
 * @returns Its `scrubText`.
 */
async function scrubberAt(sha: string): Promise<Scrub> {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- a developer script that reads the developer's own clone
  const source = execFileSync('git', ['show', `${sha}:${SCRUBBER_PATH}`], { encoding: 'utf8' })
  const standalone = source.replace(CAP_IMPORT, 'const ERROR_VALUE_MAX = 1024')
  if (/^import /m.test(standalone))
    throw new Error(`the scrubber at ${sha} has an import the loader does not replace`)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-gate-'))
  try {
    const file = path.join(directory, `scrubber-${sha}.ts`)
    fs.writeFileSync(file, standalone)
    const loaded = (await import(pathToFileURL(file).href)) as { scrubText: Scrub }
    return loaded.scrubText
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The working tree's scrubber.
 * @returns Its `scrubText`.
 */
async function workingScrubber(): Promise<Scrub> {
  const loaded = (await import(pathToFileURL(path.resolve(SCRUBBER_PATH)).href)) as {
    scrubText: Scrub
  }
  return loaded.scrubText
}

/**
 * Running totals and kept samples for one gate run.
 */
interface Totals {
  cases: number
  changed: number
  valueExposures: number
  alnumExposures: number
  otherExposures: number
  overRedacted: number
  idempotenceCandidate: number
  idempotenceBaseline: number
  idempotenceNewOnly: number
  samples: Record<string, unknown[]>
}

/**
 * A fresh set of totals.
 * @returns Zeroed totals.
 */
function emptyTotals(): Totals {
  return {
    cases: 0,
    changed: 0,
    valueExposures: 0,
    alnumExposures: 0,
    otherExposures: 0,
    overRedacted: 0,
    idempotenceCandidate: 0,
    idempotenceBaseline: 0,
    idempotenceNewOnly: 0,
    samples: {},
  }
}

/**
 * Add a sample under a heading, keeping at most `limit`.
 * @param totals - The run's totals.
 * @param heading - The sample list.
 * @param limit - The most samples kept per list.
 * @param sample - The sample.
 */
function keep(totals: Totals, heading: string, limit: number, sample: unknown): void {
  const list = (totals.samples[heading] ??= [])
  if (list.length < limit) list.push(sample)
}

/**
 * The scrubbers being compared and the most samples kept per list.
 */
interface Pair {
  baseline: Scrub
  candidate: Scrub
  limit: number
}

/**
 * Compare both scrubbers on one case and add it to the totals.
 * @param totals - The run's totals.
 * @param testCase - The case.
 * @param id - Its replay id.
 * @param pair - The scrubbers.
 */
function measure(totals: Totals, testCase: GateCase, id: string, pair: Pair): void {
  totals.cases += 1
  const before = pair.baseline(testCase.input)
  const after = pair.candidate(testCase.input)
  const sample = {
    id,
    family: testCase.family,
    input: testCase.input,
    baseline: before,
    candidate: after,
  }
  countIdempotence(totals, sample, pair, before, after)
  if (before === after) return
  totals.changed += 1
  const comparison = compareCase(testCase.planted, before, after)
  if (comparison.exposedWindows.length > 0) {
    totals.valueExposures += 1
    keep(totals, 'valueExposures', pair.limit, { ...sample, windows: comparison.exposedWindows })
  }
  if (comparison.exposedAlnum > 0) {
    totals.alnumExposures += 1
    keep(totals, 'alnumExposures', pair.limit, sample)
  } else if (comparison.exposedOther > 0) {
    totals.otherExposures += 1
    keep(totals, 'otherExposures', pair.limit, sample)
  }
  if (comparison.overRedacted === 0) return
  totals.overRedacted += 1
  keep(totals, 'overRedacted', pair.limit, sample)
}

/**
 * Count whether a second pass changes each scrubber's output.
 * @param totals - The run's totals.
 * @param sample - The case's sample.
 * @param pair - The scrubbers.
 * @param before - The baseline's output.
 * @param after - The candidate's output.
 */
function countIdempotence(
  totals: Totals,
  sample: Record<string, unknown>,
  pair: Pair,
  before: string,
  after: string
): void {
  const isCandidateStable = pair.candidate(after) === after
  const isBaselineStable = pair.baseline(before) === before
  if (!isCandidateStable) totals.idempotenceCandidate += 1
  if (!isBaselineStable) totals.idempotenceBaseline += 1
  if (isCandidateStable || !isBaselineStable) return
  totals.idempotenceNewOnly += 1
  keep(totals, 'idempotenceNewOnly', pair.limit, { ...sample, twice: pair.candidate(after) })
}

/**
 * A row of the shared fixture.
 */
interface Vector {
  rule: string
  input: string
  expected: string
}

/**
 * The counts of a fixture check, and the rows that differ.
 */
interface VectorReport {
  rows: number
  same: number
  redactsMore: number
  exposes: number
  unstable: number
  differing: unknown[]
}

/**
 * Check every fixture row: unchanged, redacts more than its expectation, or
 * exposes something the expectation hid; and whether a second pass changes it.
 * @param candidate - The scrubber under test.
 * @returns The counts and the rows that differ.
 */
function checkVectors(candidate: Scrub): VectorReport {
  const vectors = JSON.parse(
    fs.readFileSync('tests/fixtures/error-scrub-vectors.json', 'utf8')
  ) as Vector[]
  const differing: unknown[] = []
  const counts = { rows: vectors.length, same: 0, redactsMore: 0, exposes: 0, unstable: 0 }
  for (const [row, vector] of vectors.entries()) {
    const output = candidate(vector.input)
    if (candidate(output) !== output) counts.unstable += 1
    if (output === vector.expected) {
      counts.same += 1
      continue
    }
    const comparison = compareCase([], vector.expected, output)
    const isExposing = comparison.exposedAlnum + comparison.exposedOther > 0
    if (isExposing) counts.exposes += 1
    else counts.redactsMore += 1
    differing.push({ row, verdict: isExposing ? 'exposes' : 'redacts-more', ...vector, output })
  }
  return { ...counts, differing }
}

/**
 * Write the slice the unit suite checks, formatted as the repository's
 * Prettier config says: for each case the planted values
 * (by index) the baseline leaves partly in view, and the cases the baseline
 * itself changes on a second pass.
 * @param baseline - The baseline scrubber.
 * @param options - The options.
 */
async function writeSlice(baseline: Scrub, options: Options): Promise<void> {
  const seed = options.seed ?? CORPUS_SEED
  const allowed: Record<string, number[]> = {}
  const unstable: number[] = []
  for (let index = 0; index < options.count; index += 1) {
    const testCase = corpusCase(seed, index)
    const output = baseline(testCase.input)
    const shown = testCase.planted.flatMap((value, at) =>
      visibleWindows(output, value).length > 0 ? [at] : []
    )
    if (shown.length > 0) allowed[index] = shown
    if (baseline(output) !== output) unstable.push(index)
  }
  const slice = {
    seed,
    count: options.count,
    baseline: options.baseline,
    allowed,
    unstable,
  }
  const config = await resolveConfig(SLICE_FILE)
  fs.writeFileSync(
    SLICE_FILE,
    await format(JSON.stringify(slice), { ...config, filepath: SLICE_FILE })
  )
  console.log(`wrote ${SLICE_FILE}: ${Object.keys(allowed).length} of ${options.count} cases`)
}

/**
 * Compare the scrubbers over a corpus or a hunt, print the totals and write
 * the samples to a temporary file.
 * @param pair - The scrubbers.
 * @param options - The options.
 */
function runCases(pair: Pair, options: Options): void {
  const started = Date.now()
  const isHunt = options.mode === 'hunt'
  const seed = options.seed ?? started % 2_147_483_647
  const make = isHunt ? huntCase : corpusCase
  const totals = emptyTotals()
  for (let index = 0; index < options.count; index += 1) {
    if (options.seconds > 0 && Date.now() - started > options.seconds * 1000) break
    measure(totals, make(seed, index), `${options.mode}:${seed}:${index}`, pair)
  }
  const { samples, ...counts } = totals
  const seconds = Math.round((Date.now() - started) / 1000)
  const candidate = options.candidateSha ?? 'working tree'
  const summary = {
    mode: options.mode,
    seed,
    baseline: options.baseline,
    candidate,
    seconds,
    ...counts,
  }
  console.log(JSON.stringify(summary, undefined, 2))
  const samplesFile = path.join(os.tmpdir(), `scrub-gate-${options.mode}-${seed}.json`)
  fs.writeFileSync(samplesFile, JSON.stringify(samples, undefined, 2))
  console.log(`samples: ${samplesFile}`)
  if (totals.valueExposures + totals.alnumExposures + totals.idempotenceNewOnly > 0)
    process.exitCode = 1
  if (totals.cases > 0) return
  console.error('no case ran, so nothing was measured')
  process.exitCode = 1
}

/**
 * Show one case under both scrubbers.
 * @param pair - The scrubbers.
 * @param replay - `corpus:<seed>:<index>` or `hunt:<seed>:<index>`.
 */
function replayCase(pair: Pair, replay: string): void {
  const [kind, seed, index] = replay.split(':', 3)
  const make = kind === 'hunt' ? huntCase : corpusCase
  const testCase = make(Number(seed), Number(index))
  const totals = emptyTotals()
  measure(totals, testCase, replay, pair)
  const outputs = {
    baselineOutput: pair.baseline(testCase.input),
    candidateOutput: pair.candidate(testCase.input),
  }
  console.log(JSON.stringify({ ...testCase, ...outputs, totals }, undefined, 2))
}

/**
 * Run the gate.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.mode === 'vectors') {
    const report = checkVectors(await workingScrubber())
    console.log(JSON.stringify(report, undefined, 2))
    if (report.same !== report.rows || report.unstable > 0 || report.exposes > 0)
      process.exitCode = 1
    return
  }
  const baseline = await scrubberAt(options.baseline)
  if (options.mode === 'slice') {
    await writeSlice(baseline, options)
    return
  }
  const candidate =
    options.candidateSha === undefined
      ? await workingScrubber()
      : await scrubberAt(options.candidateSha)
  const pair: Pair = { baseline, candidate, limit: options.samples }
  if (options.mode === 'replay' && options.replay !== undefined) replayCase(pair, options.replay)
  else runCases(pair, options)
}

try {
  await main()
} catch (error) {
  console.error(`scrub:gate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
