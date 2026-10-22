/**
 * @file Lints a synthetic file with the repo's real Oxlint config, for
 * tests/unit/lint-gates.test.ts. `vp lint` reads no stdin, so each call
 * builds a throwaway copy of the lint scope under the OS temp dir and lints
 * the probe there at its repo-relative path, which is what makes the
 * path-keyed overrides (`src/services/platform-*.service.ts`,
 * `tests/helpers/timing.ts`, …) apply.
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

/**
 * One Oxlint diagnostic from `--format json`. A parse error has no `code`.
 */
interface OxlintDiagnostic {
  message: string
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
 * Runs `vp lint --format json` in `cwd` on `filePath`, resolving with stdout
 * even when Oxlint exits 1 for an error-level finding.
 */
async function runOxlint(cwd: string, filePath: string): Promise<string> {
  const vp = path.join(repoRoot, 'node_modules/.bin/vp')
  try {
    const { stdout } = await execFileAsync(vp, ['lint', '--format', 'json', filePath], { cwd })
    return stdout
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.includes('"diagnostics"')) return stdout
    throw error
  }
}

/**
 * Lints `source` as if it lived at the repo-relative `filePath`, with the
 * repo's real Oxlint config, and returns each finding's rule id
 * (`eslint/no-restricted-imports`, `import/no-cycle`, …) and severity (2 for
 * error, 1 for warning). The temp copy is removed in `finally`; nothing is
 * written inside the repo.
 * @throws {Error} When Oxlint reports a parse error or lints no file. Either
 *   would otherwise read as "no rule fired", the inert-gate pass
 *   lint-gates.test.ts exists to catch.
 */
export async function oxlintMessagesFor(
  filePath: string,
  source: string
): Promise<{ ruleId: string; severity: 1 | 2 }[]> {
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
    await fs.mkdir(path.dirname(path.join(scope, filePath)), { recursive: true })
    await fs.writeFile(path.join(scope, filePath), source)

    const stdout = await runOxlint(scope, filePath)
    const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as OxlintReport
    if (report.number_of_files !== 1) {
      throw new Error(`oxlint linted ${String(report.number_of_files)} files for ${filePath}`)
    }
    const parseError = report.diagnostics.find((diagnostic) => diagnostic.code === undefined)
    if (parseError) throw new Error(`oxlint could not parse ${filePath}: ${parseError.message}`)

    return report.diagnostics.map((diagnostic) => ({
      ruleId: String(diagnostic.code).replace(/^([\w-]+)\((.+)\)$/, '$1/$2'),
      severity: diagnostic.severity === 'error' ? 2 : 1,
    }))
  } finally {
    await fs.rm(scope, { recursive: true, force: true })
  }
}
