/**
 * @file The scrubber gate's command-line options (tests/helpers/scrub-gate.ts).
 * Anything it cannot read is refused with an error, never replaced by a
 * default: a typo that ran the default corpus, or no cases at all, would
 * report a pass it never measured.
 */

/**
 * The commit whose scrubber is the baseline, and the one the slice file was
 * written from, unless `--baseline` names another.
 */
const DEFAULT_BASELINE = '713112c'

/**
 * The fixed seed of the corpus and the slice, when `--seed` is not given.
 */
export const CORPUS_SEED = 20_261_010

/**
 * The gate's modes.
 */
const MODES = ['corpus', 'hunt', 'vectors', 'replay', 'slice'] as const

/**
 * One of the gate's modes.
 */
type Mode = (typeof MODES)[number]

/**
 * The options that take a value; every option does.
 */
const FLAGS = new Set([
  'seed',
  'count',
  'seconds',
  'baseline',
  'candidate-sha',
  'samples',
  'replay',
])

/**
 * The options each mode does not read, which it refuses rather than ignores.
 */
const UNREAD_FLAGS: Partial<Record<Mode, readonly string[]>> = {
  vectors: ['candidate-sha', 'baseline', 'seed', 'count', 'seconds', 'samples'],
  replay: ['seed', 'count'],
}

/**
 * A replay id: `corpus:<seed>:<index>` or `hunt:<seed>:<index>`.
 */
const REPLAY_ID = /^(?:corpus|hunt):\d+:\d+$/

/**
 * Parsed command-line options.
 */
export interface Options {
  mode: Mode
  /**
   * The seed given; for corpus and slice the fixed seed when none is. Hunt
   * picks a time seed when this is undefined.
   */
  seed: number | undefined
  count: number
  seconds: number
  baseline: string
  candidateSha: string | undefined
  samples: number
  replay: string | undefined
}

/**
 * Whether a word names a mode.
 * @param word - The first argument.
 * @returns True for one of the modes.
 */
function isMode(word: string): word is Mode {
  return (MODES as readonly string[]).includes(word)
}

/**
 * Read a whole number option, refusing anything but plain digits at or above
 * the minimum.
 * @param given - The options given, by name.
 * @param name - The option.
 * @param fallback - The value when the option is not given.
 * @param minimum - The smallest value accepted.
 * @returns The number.
 */
function wholeNumber<Fallback extends number | undefined>(
  given: ReadonlyMap<string, string>,
  name: string,
  fallback: Fallback,
  minimum: number
): number | Fallback {
  const text = given.get(name)
  if (text === undefined) return fallback
  const parsed = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`--${name} must be a whole number of at least ${minimum}, got "${text}"`)
  return parsed
}

/**
 * Read the `--name value` pairs.
 * @param rest - The arguments after the mode.
 * @returns The options given, by name.
 * @throws {Error} On an unknown option, or one given twice or with no value.
 */
function readFlags(rest: readonly string[]): Map<string, string> {
  const given = new Map<string, string>()
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at] ?? ''
    const name = flag.slice(2)
    if (!flag.startsWith('--') || !FLAGS.has(name)) throw new Error(`unknown option "${flag}"`)
    if (given.has(name)) throw new Error(`--${name} is given more than once`)
    const value = rest[at + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    given.set(name, value)
  }
  return given
}

/**
 * Refuse a malformed or misplaced `--replay`, and any option the mode does
 * not read.
 * @param mode - The mode.
 * @param given - The options given, by name.
 * @throws {Error} On replay mode without a well-formed `--replay`, `--replay`
 * in another mode, or an option in the mode's `UNREAD_FLAGS`.
 */
function refuseMisplaced(mode: Mode, given: ReadonlyMap<string, string>): void {
  const replay = given.get('replay')
  if (mode === 'replay' && (replay === undefined || !REPLAY_ID.test(replay)))
    throw new Error('replay needs --replay corpus:<seed>:<index> or hunt:<seed>:<index>')
  if (mode !== 'replay' && replay !== undefined)
    throw new Error('--replay is read only in replay mode')
  const unread = UNREAD_FLAGS[mode] ?? []
  for (const name of unread) {
    if (given.has(name)) throw new Error(`--${name} is not read in ${mode} mode`)
  }
}

/**
 * Read the options: the mode, then `--name value` pairs.
 * @param argv - The arguments after the script name.
 * @returns The options.
 * @throws {Error} On an unknown mode or option, an option given twice or with
 * no value, a malformed number or replay id, `--replay` outside replay mode,
 * or an option the mode does not read (`UNREAD_FLAGS`).
 */
export function parseOptions(argv: readonly string[]): Options {
  const [mode = 'corpus', ...rest] = argv
  if (!isMode(mode)) throw new Error(`unknown mode "${mode}"; expected one of ${MODES.join(', ')}`)
  const given = readFlags(rest)
  refuseMisplaced(mode, given)
  const isFixedSeed = mode === 'corpus' || mode === 'slice'
  return {
    mode,
    seed: wholeNumber(given, 'seed', isFixedSeed ? CORPUS_SEED : undefined, 1),
    count: wholeNumber(given, 'count', mode === 'slice' ? 2000 : 1_000_000, 1),
    seconds: wholeNumber(given, 'seconds', 0, 1),
    baseline: given.get('baseline') ?? DEFAULT_BASELINE,
    candidateSha: given.get('candidate-sha'),
    samples: wholeNumber(given, 'samples', 20, 0),
    replay: given.get('replay'),
  }
}
