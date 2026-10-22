/**
 * @file Lints synthetic files with the repo's real Oxlint config, for
 * tests/unit/lint-gates.test.ts. `vp lint` reads no stdin, so the probes go
 * into a throwaway copy of the lint scope under the OS temp dir, each at its
 * repo-relative path, which is what makes the path-keyed overrides
 * (`src/services/platform-*.service.ts`, `tests/helpers/timing.ts`, …)
 * apply. All probes lint in one batch: a test registers its probes while the
 * file is collected and reads its findings back after `beforeAll` runs them.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * What each temp copy holds besides the probe. The config imports
 * worker-database.ts; tsgolint reads the tsconfigs; `src/` gives import/no-cycle
 * the real module graph a probe can close a cycle through; the lint-cycle
 * fixtures bring their own tsconfig, whose "@/*" alias Oxlint picks up as the
 * nearest one.
 */
const COPIED_PATHS = [
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'tests/helpers/worker-database.ts',
  'src',
  'tests/fixtures/lint-cycle',
]

/**
 * The temp copy's config: the real one, minus the tests/fixtures/** ignore,
 * so a committed fixture can be linted on purpose while `pnpm lint` keeps
 * skipping it. `--no-ignore` does not lift a config's `ignorePatterns`.
 */
const WRAPPER_CONFIG = `import base from './vite.base.config.ts'

export default {
  ...base,
  lint: {
    ...base.lint,
    ignorePatterns: base.lint.ignorePatterns.filter((pattern) => pattern !== 'tests/fixtures/**'),
  },
}
`

/** The message of the code-less diagnostic `reportUnusedDisableDirectives` emits. */
const UNUSED_DIRECTIVE = /^Unused (?:oxlint|eslint)-(?:disable|enable) directive/
/** The rule id the probe reports for an unused directive, which Oxlint reports with no code. */
export const UNUSED_DIRECTIVE_RULE_ID = 'unused-disable-directive'

/**
 * One Oxlint diagnostic from `--format json`. A parse error and an unused
 * disable directive have no `code`.
 */
interface OxlintDiagnostic {
  message: string
  filename: string
  code?: string
  severity: 'error' | 'warning' | 'advice'
}

/**
 * The parts of Oxlint's JSON report the probe reads.
 */
interface OxlintReport {
  diagnostics: OxlintDiagnostic[]
  number_of_files: number
}

/**
 * The bound on one `vp lint` run, below lint-gates.test.ts's 75 s suite
 * timeout, so a hung run is killed and its temp copy still removed.
 */
const VP_LINT_TIMEOUT_MS = 60_000

/** One finding, in the shape lint-gates.test.ts asserts on. */
export interface OxlintMessage {
  ruleId: string
  severity: 1 | 2
}

/** A registered probe: the repo-relative path it lints at, and its text. */
interface Probe {
  filePath: string
  source: string
}

/** Every probe registered and not yet linted. */
const pending: Probe[] = []
/** Each linted probe's findings, keyed by {@link probeKey}. */
const results = new Map<string, OxlintMessage[]>()

/** The cache key of a probe: its path and text. */
function probeKey(filePath: string, source: string): string {
  return `${filePath}\0${source}`
}

/**
 * Runs `vp lint --format json` in `cwd` on `filePaths`, resolving with stdout
 * even when Oxlint exits 1 for an error-level finding.
 */
async function runOxlint(cwd: string, filePaths: string[]): Promise<string> {
  const vp = path.join(repoRoot, 'node_modules/.bin/vp')
  try {
    const { stdout } = await execFileAsync(vp, ['lint', '--format', 'json', ...filePaths], {
      cwd,
      timeout: VP_LINT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.includes('"diagnostics"')) return stdout
    throw error
  }
}

/**
 * The absolute path of `filePath` inside `scope`.
 * @throws {Error} When `filePath` is absolute or climbs out of `scope`.
 */
function insideScope(scope: string, filePath: string): string {
  const target = path.resolve(scope, filePath)
  if (path.isAbsolute(filePath) || !target.startsWith(scope + path.sep)) {
    throw new Error(`oxlint probe path ${filePath} is outside the lint scope`)
  }
  return target
}

/**
 * Lints one round of probes, no two at the same path, in a single temp copy
 * with a single `vp lint` run, and stores each probe's findings.
 * @throws {Error} When Oxlint reports a parse error or skips a probe. Either
 *   would otherwise read as "no rule fired", the inert-gate pass
 *   lint-gates.test.ts exists to catch.
 */
async function lintRound(round: Probe[]): Promise<void> {
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'oxlint-probe-'))
  try {
    await Promise.all(
      COPIED_PATHS.map((relativePath) =>
        fs.cp(path.join(repoRoot, relativePath), path.join(scope, relativePath), {
          recursive: true,
        })
      )
    )
    await fs.copyFile(
      path.join(repoRoot, 'vite.config.ts'),
      path.join(scope, 'vite.base.config.ts')
    )
    await fs.writeFile(path.join(scope, 'vite.config.ts'), WRAPPER_CONFIG)
    await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(scope, 'node_modules'), 'dir')
    for (const { filePath, source } of round) {
      const target = insideScope(scope, filePath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, source)
    }

    const filePaths = round.map((probe) => probe.filePath)
    const stdout = await runOxlint(scope, filePaths)
    const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as OxlintReport
    if (report.number_of_files !== round.length) {
      throw new Error(
        `oxlint linted ${String(report.number_of_files)} of ${String(round.length)} probes`
      )
    }
    const parseError = report.diagnostics.find(
      (diagnostic) => diagnostic.code === undefined && !UNUSED_DIRECTIVE.test(diagnostic.message)
    )
    if (parseError) {
      throw new Error(`oxlint could not parse ${parseError.filename}: ${parseError.message}`)
    }

    for (const { filePath, source } of round) {
      const messages = report.diagnostics
        .filter((diagnostic) => path.normalize(diagnostic.filename) === path.normalize(filePath))
        .map((diagnostic) => ({
          ruleId:
            diagnostic.code === undefined
              ? UNUSED_DIRECTIVE_RULE_ID
              : diagnostic.code.replace(/^([\w-]+)\((.+)\)$/, '$1/$2'),
          severity: diagnostic.severity === 'error' ? (2 as const) : (1 as const),
        }))
      results.set(probeKey(filePath, source), messages)
    }
  } finally {
    await fs.rm(scope, { recursive: true, force: true })
  }
}

/**
 * Queues `source` to be linted as if it lived at the repo-relative
 * `filePath`. Call it while the test file is collected, then
 * {@link runOxlintProbes} once in `beforeAll`.
 * @throws {Error} When `filePath` is absolute or climbs out of the repo.
 */
export function registerOxlintProbe(filePath: string, source: string): void {
  if (path.isAbsolute(filePath) || path.normalize(filePath).split(path.sep)[0] === '..') {
    throw new Error(`oxlint probe path ${filePath} is outside the lint scope`)
  }
  const key = probeKey(filePath, source)
  if (results.has(key) || pending.some((probe) => probeKey(probe.filePath, probe.source) === key)) {
    return
  }
  pending.push({ filePath, source })
}

/**
 * Lints every queued probe with the repo's real Oxlint config. Probes that
 * share a path go to separate rounds, since one copy holds one file per path;
 * the rounds run in parallel, one `vp lint` each. Each round's temp copy is
 * removed in `finally`; nothing is written inside the repo.
 */
export async function runOxlintProbes(): Promise<void> {
  const rounds: Probe[][] = []
  for (const probe of pending.splice(0)) {
    const round = rounds.find((candidate) =>
      candidate.every((other) => other.filePath !== probe.filePath)
    )
    if (round) round.push(probe)
    else rounds.push([probe])
  }
  await Promise.all(rounds.map((round) => lintRound(round)))
}

/**
 * The findings for a probe {@link runOxlintProbes} linted: each rule id
 * (`eslint/no-restricted-imports`, `import/no-cycle`, …) and severity (2 for
 * error, 1 for warning).
 * @throws {Error} When the probe was never registered and run, so a typo in
 *   a test's path or source fails instead of reading as "no rule fired".
 */
export function oxlintMessagesFor(filePath: string, source: string): Promise<OxlintMessage[]> {
  const messages = results.get(probeKey(filePath, source))
  if (!messages) {
    return Promise.reject(
      new Error(`oxlint probe ${filePath} was not registered before runOxlintProbes()`)
    )
  }
  return Promise.resolve(messages)
}
