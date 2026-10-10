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
 * The fixed corpus seed, also the slice's.
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
 * A replay id: `corpus:<seed>:<index>` or `hunt:<seed>:<index>`.
 */
const REPLAY_ID = /^(?:corpus|hunt):\d+:\d+$/

/**
 * Parsed command-line options.
 */
export interface Options {
  mode: Mode
  seed: number
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
function wholeNumber(
  given: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number
): number {
  const text = given.get(name)
  if (text === undefined) return fallback
  const parsed = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`--${name} must be a whole number of at least ${minimum}, got "${text}"`)
  return parsed
}

/**
 * Read the options: the mode, then `--name value` pairs.
 * @param argv - The arguments after the script name.
 * @returns The options.
 * @throws {Error} On an unknown mode or option, an option given twice or with
 * no value, a malformed number or replay id, or `--replay` outside replay mode.
 */
export function parseOptions(argv: readonly string[]): Options {
  const [mode = 'corpus', ...rest] = argv
  if (!isMode(mode)) throw new Error(`unknown mode "${mode}"; expected one of ${MODES.join(', ')}`)
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
  const replay = given.get('replay')
  if (mode === 'replay' && (replay === undefined || !REPLAY_ID.test(replay)))
    throw new Error('replay needs --replay corpus:<seed>:<index> or hunt:<seed>:<index>')
  if (mode !== 'replay' && replay !== undefined)
    throw new Error('--replay is read only in replay mode')
  return {
    mode,
    seed: wholeNumber(given, 'seed', CORPUS_SEED, 1),
    count: wholeNumber(given, 'count', 1_000_000, 1),
    seconds: wholeNumber(given, 'seconds', 0, 1),
    baseline: given.get('baseline') ?? DEFAULT_BASELINE,
    candidateSha: given.get('candidate-sha'),
    samples: wholeNumber(given, 'samples', 20, 0),
    replay,
  }
}
