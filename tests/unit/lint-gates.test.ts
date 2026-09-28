/**
 * @file These assert that the lint gates FIRE, not that the config file
 * contains certain keys. A gate that is configured but inert lints green
 * while enforcing nothing, which is worse than having no gate at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ESLint, type Linter } from 'eslint'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

/**
 * Lints with the repo's real config (type-aware `parserOptions.project`),
 * `ignore: false` so the committed cycle fixtures under tests/fixtures/ can
 * be linted deliberately here, while `pnpm lint` keeps skipping them. Its
 * type-aware project is required for the no-cycle case below, whose
 * fixtures are real, committed files the project can resolve.
 */
const eslint = new ESLint({ cwd: process.cwd(), ignore: false })

/**
 * Lints synthetic text at a `filePath` that need not exist on disk.
 * `parserOptions.project` resolves included files through a real tsconfig
 * watch program (see eslint.config.mjs), unlike the old `projectService:
 * true`, so a path that isn't really on disk fatals before any rule runs
 * under the type-checked rule set; `disableTypeChecked` avoids that, since
 * none of the rules exercised via `lintText` need type information.
 * `disallowAutomaticSingleRunInference` avoids a second failure mode: under
 * `CI=true`, typescript-estree treats a second parse of the same path as a
 * fix pass and builds an isolated program for it, and the probes below
 * reuse one path — which can crash a third-party type-aware rule such as
 * `sonarjs/deprecation` running on that virtual file.
 */
const eslintText = new ESLint({
  cwd: process.cwd(),
  ignore: false,
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } },
  ],
})

/**
 * The lint-cycle fixture's own tsconfig, mapping "@/*" to "./*" instead of
 * the root tsconfig's "@/*" -> "./src/*" — needed because the aliased
 * fixture (tests/fixtures/lint-cycle/cycle-a.ts) imports "@/cycle-b", which
 * the repo's default project and resolver cannot see.
 */
const aliasedCycleTsconfig = path.join(process.cwd(), 'tests/fixtures/lint-cycle/tsconfig.json')
/**
 * Points BOTH the type-aware parser's project and the resolver's tsconfig
 * at {@link aliasedCycleTsconfig}. Overriding only one of the two either
 * fatals (the parser finds the file in no project) or leaves no-cycle
 * silently unable to resolve the aliased import.
 */
const eslintAliasedCycle = new ESLint({
  cwd: process.cwd(),
  ignore: false,
  overrideConfig: {
    languageOptions: {
      parserOptions: {
        project: ['./tests/fixtures/lint-cycle/tsconfig.json'],
        tsconfigRootDir: process.cwd(),
      },
    },
    settings: {
      'import-x/resolver-next': [
        importX.createNodeResolver({
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.node'],
          tsconfig: { configFile: aliasedCycleTsconfig },
        }),
      ],
    },
  },
})

/**
 * Lints `source` at a synthetic `filePath` via {@link eslintText}.
 * @param filePath - A path used to select config, real or not.
 * @param source - The text to lint.
 * @returns The lint messages.
 * @throws {Error} When ESLint fatals on `source` — a fatal reports with `ruleId:
 * null`, which a caller mapping to `ruleId ?? ''` would silently read as
 * "no rule fired", turning a `not.toContain` assertion into a vacuous
 * pass. That is exactly the inert-gate failure mode this file exists to
 * catch, so it fails loudly instead.
 */
const messagesFor = async (filePath: string, source: string): Promise<Linter.LintMessage[]> => {
  const [result] = await eslintText.lintText(source, { filePath })
  const messages = result?.messages ?? []
  const fatal = messages.find((message) => message.fatal)
  if (fatal) throw new Error(`eslint fataled on ${filePath}: ${fatal.message}`)
  return messages
}

/**
 * The rule ids {@link messagesFor} reported for `source`.
 * @param filePath - A path used to select config, real or not.
 * @param source - The text to lint.
 * @returns Each message's rule id, `''` for a fatal.
 */
const ruleIdsFor = async (filePath: string, source: string): Promise<string[]> => {
  const messages = await messagesFor(filePath, source)
  return messages.map((message) => message.ruleId ?? '')
}

/**
 * This suite's own timeout, in place of the global 20s (vitest.config.ts).
 * On an idle machine the two cold tests (first `lintText`, first
 * `lintFiles`, building the real TS program the no-cycle fixtures need)
 * run in ~1.1-1.5s each and every later test in each group costs 7-40ms,
 * since both ESLint instances above are module-scoped and reused. Run
 * immediately after `pnpm lint && pnpm build` — the sequence CI runs —
 * those same two cold tests were observed at 20.2s and once at 61s: eight
 * vitest workers, v8 coverage instrumentation, and a just-finished `tsc`
 * all compete for the CPU while ESLint type-checks the project from cold.
 * It is this variance that made the file flaky, not the mean, so the
 * timeout is generous (2x the worst contended run observed here) rather
 * than tuned close to it; raising the global timeout instead would hide a
 * real slowdown anywhere else in the suite.
 */
const LINT_GATE_TIMEOUT_MS = 120_000

describe('lint gates actually fire', { timeout: LINT_GATE_TIMEOUT_MS }, () => {
  it('rejects an undocumented export', async () => {
    const messages = await messagesFor(
      'src/utilities/probe.utilities.ts',
      'export function p(): string { return "x" }\n'
    )
    const jsdocMessage = messages.find((message) => message.ruleId === 'jsdoc/require-jsdoc')
    // Checks severity, not just presence, so a gate downgraded to "warn" (still green under --max-warnings unset, and still passing a bare toContain) is also caught.
    expect(jsdocMessage?.severity).toBe(2)
  })

  it('accepts a documented export', async () => {
    const ids = await ruleIdsFor(
      'src/utilities/probe.utilities.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('jsdoc/require-jsdoc')
  })

  /**
   * Parameterized (sonarjs/parameterized-tests) rather than one `it()`
   * per directory: three near-identical accepts/rejects pairs across
   * src/controllers/, src/jobs/ and src/workers/ trip that rule
   * otherwise.
   */
  const governedDirectoryCases = [
    {
      label: 'a governed directory',
      validPath: 'src/controllers/user.controller.ts',
      invalidPath: 'src/controllers/user.ts',
    },
    { label: 'src/jobs/', validPath: 'src/jobs/email.job.ts', invalidPath: 'src/jobs/email.ts' },
    {
      label: 'src/workers/',
      validPath: 'src/workers/email.worker.ts',
      invalidPath: 'src/workers/email.ts',
    },
  ]

  it.each(governedDirectoryCases)(
    'accepts a correctly named file in $label',
    async ({ validPath }) => {
      const ids = await ruleIdsFor(
        validPath,
        '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
      )
      expect(ids).not.toContain('check-file/filename-naming-convention')
    }
  )

  it.each(governedDirectoryCases)(
    'rejects a wrongly named file in $label',
    async ({ invalidPath }) => {
      const messages = await messagesFor(
        invalidPath,
        '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
      )
      const checkFileMessage = messages.find(
        (message) => message.ruleId === 'check-file/filename-naming-convention'
      )
      expect(checkFileMessage?.severity).toBe(2)
    }
  )

  it('allows process.env inside env.config and blocks it elsewhere', async () => {
    const source = 'export const x = process.env.FOO\n'
    expect(await ruleIdsFor('src/configs/env.config.ts', source)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/services/other.service.ts', source)).toContain(
      'no-restricted-properties'
    )
  })

  it('allows console.error inside logger.service.ts and index.ts but blocks it elsewhere', async () => {
    const source = 'export function f(): void { console.error("x") }\n'
    expect(await ruleIdsFor('src/services/logger.service.ts', source)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/index.ts', source)).not.toContain('no-restricted-properties')
    expect(await ruleIdsFor('src/services/other.service.ts', source)).toContain(
      'no-restricted-properties'
    )
  })

  // tracing.ts loads via `--import` before getEnv() has run, so like env.config.ts/logger.service.ts/index.ts it may read process.env directly and use console.*; the exemption is scoped to this one filename, not the whole directory.
  it('allows process.env and console.* inside tracing.ts but blocks them in a sibling file', async () => {
    const processEnvSource = 'export const x = process.env.FOO\n'
    const consoleSource = 'export function f(): void { console.info("x") }\n'

    expect(await ruleIdsFor('src/observability/tracing.ts', processEnvSource)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/observability/tracing.ts', consoleSource)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/observability/other.ts', processEnvSource)).toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/observability/other.ts', consoleSource)).toContain(
      'no-restricted-properties'
    )
  })

  it('does not enforce filename-naming-convention under src/observability/', async () => {
    const ids = await ruleIdsFor(
      'src/observability/tracing.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('check-file/filename-naming-convention')
  })

  it('allows a deliberately-unused underscore-prefixed handler parameter', async () => {
    // Express identifies an error handler by arity (four parameters); `response` is used in the body (matching a real handler), so the rule's "after-used" default alone would not exempt the unused fourth — only the underscore prefix does.
    const source =
      'export function h(error: unknown, request: unknown, response: { end: () => void }, _next: unknown): void { response.end() }\n'
    const ids = await ruleIdsFor('src/middlewares/probe.middleware.ts', source)
    expect(ids).not.toContain('@typescript-eslint/no-unused-vars')
  })

  it('still rejects a genuinely-unused parameter with no underscore', async () => {
    // If this does not fire, argsIgnorePattern has become a blanket suppression rather than an opt-in convention.
    const source =
      'export function h(error: unknown, request: unknown, response: { end: () => void }, next: unknown): void { response.end() }\n'
    const messages = await messagesFor('src/middlewares/probe.middleware.ts', source)
    const unusedVariablesMessage = messages.find(
      (message) => message.ruleId === '@typescript-eslint/no-unused-vars'
    )
    expect(unusedVariablesMessage?.severity).toBe(2)
  })

  // no-cycle follows imports through real files on disk (import-x reads them with fs.readFileSync); this proves the rule fires at all, on a relative import.
  it('rejects a circular import between real files (relative import)', async () => {
    const results = await eslint.lintFiles(['tests/fixtures/lint-cycle/a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  // Runs under its own resolver and tsconfig, so this does NOT guard eslint.config.mjs's own resolver settings — only the real-config case below does.
  it('rejects a circular import between real files (aliased "@/" import, own local tsconfig)', async () => {
    const results = await eslintAliasedCycle.lintFiles(['tests/fixtures/lint-cycle/cycle-a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  // The one case that guards eslint.config.mjs's `import-x/resolver-next`: auth.middleware.ts imports auth.constants.ts, so linting auth.constants.ts with an import of auth.middleware closes a real cycle through the "@/" alias, resolved by the real config. A cwd-relative tsconfig `configFile` there that resolved "@/*" to relative paths (which never === the absolute `physicalFilename` no-cycle compares against) would go red only here.
  it('rejects a circular "@/" import resolved by the real config', async () => {
    const source =
      "import { requireAuth } from '@/middlewares/auth.middleware'\n\nexport const x = requireAuth\n"
    const messages = await messagesFor('src/constants/auth.constants.ts', source)
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  /**
   * Each zone is linted through `lintText` at a synthetic path inside the
   * zone's target directory, since `import-x/no-restricted-paths` matches
   * a zone on the linted file's own path — a fixture linted where it
   * physically lives (tests/fixtures/) would never match a src/ target.
   * The imported module is still resolved for real, so every fixture
   * imports a file that exists.
   */
  describe('import-x/no-restricted-paths zones', () => {
    const zoneCases = [
      {
        label: 'controllers must not import repositories',
        fixture: 'tests/fixtures/lint-zones/controller-imports-repository.ts',
        syntheticPath: 'src/controllers/probe.controller.ts',
      },
      {
        label: 'controllers must not import other controllers',
        fixture: 'tests/fixtures/lint-zones/controller-imports-controller.ts',
        syntheticPath: 'src/controllers/probe.controller.ts',
      },
      {
        label: 'services must not import middlewares',
        fixture: 'tests/fixtures/lint-zones/service-imports-middleware.ts',
        syntheticPath: 'src/services/probe.service.ts',
      },
      {
        label: 'errors must not import middlewares',
        fixture: 'tests/fixtures/lint-zones/error-imports-middleware.ts',
        syntheticPath: 'src/errors/probe-errors.ts',
      },
      {
        label: 'presenters must not import controllers',
        fixture: 'tests/fixtures/lint-zones/presenter-imports-controller.ts',
        syntheticPath: 'src/presenters/probe.presenter.ts',
      },
      {
        label: 'repositories must not import services (except database.service)',
        fixture: 'tests/fixtures/lint-zones/repository-imports-service.ts',
        syntheticPath: 'src/repositories/probe.repository.ts',
      },
      {
        label: 'policies must not import repositories',
        fixture: 'tests/fixtures/lint-zones/policy-imports-repository.ts',
        syntheticPath: 'src/policies/probe.policy.ts',
      },
      {
        label: 'configs must not import controllers',
        fixture: 'tests/fixtures/lint-zones/config-imports-controller.ts',
        syntheticPath: 'src/configs/probe.config.ts',
      },
    ]

    it.each(zoneCases)('rejects: $label', async ({ fixture, syntheticPath }) => {
      const source = fs.readFileSync(path.resolve(process.cwd(), fixture), 'utf8')
      const messages = await messagesFor(syntheticPath, source)
      const zoneMessage = messages.find(
        (message) => message.ruleId === 'import-x/no-restricted-paths'
      )
      expect(zoneMessage?.severity).toBe(2)
    })

    // The controllers zone has two `from` paths; the fixture above exercises only repositories, so this exercises services/database.service inline.
    it('rejects: controllers must not import services/database.service', async () => {
      const source =
        "import { db } from '@/services/database.service'\n\nexport const client = db\n"
      const messages = await messagesFor('src/controllers/probe.controller.ts', source)
      const zoneMessage = messages.find(
        (message) => message.ruleId === 'import-x/no-restricted-paths'
      )
      expect(zoneMessage?.severity).toBe(2)
    })

    // The controllers-to-controllers zone excepts the two shared modules every controller builds on; without it every real controller would fail the zone.
    it('allows a controller to import base.controller and helpers.controller', async () => {
      const source =
        "import { BaseController } from '@/controllers/base.controller'\n" +
        "import { authenticatedUserId } from '@/controllers/helpers.controller'\n\n" +
        'export const shared = [BaseController, authenticatedUserId]\n'
      const ids = await ruleIdsFor('src/controllers/probe.controller.ts', source)
      expect(ids).not.toContain('import-x/no-restricted-paths')
    })

    // Negative control: the same import must not fire from an unrelated layer, or the zone would be matching on the import alone rather than the (target, from) pair.
    it('does not fire the controllers zone for a file outside src/controllers/', async () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), 'tests/fixtures/lint-zones/controller-imports-repository.ts'),
        'utf8'
      )
      const ids = await ruleIdsFor('src/services/probe.service.ts', source)
      expect(ids).not.toContain('import-x/no-restricted-paths')
    })
  })

  describe('no-restricted-imports: repositories/platform-tenant.repository', () => {
    const fixture = 'tests/fixtures/lint-zones/service-imports-platform-tenant-repository.ts'

    it.each([
      'src/services/tenant.service.ts',
      'src/services/audit.service.ts',
      'src/middlewares/probe.middleware.ts',
      'src/repositories/probe.repository.ts',
    ])('rejects an import from %s', async (syntheticPath) => {
      const source = fs.readFileSync(path.resolve(process.cwd(), fixture), 'utf8')
      const messages = await messagesFor(syntheticPath, source)
      const restricted = messages.find((message) => message.ruleId === 'no-restricted-imports')
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const source =
        "import { PlatformTenantRepository } from './platform-tenant.repository'\n\n" +
        'export const repository = PlatformTenantRepository\n'
      const messages = await messagesFor('src/repositories/probe.repository.ts', source)
      const restricted = messages.find((message) => message.ruleId === 'no-restricted-imports')
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const source = fs.readFileSync(path.resolve(process.cwd(), fixture), 'utf8')
      const ids = await ruleIdsFor('src/services/platform-tenant.service.ts', source)
      expect(ids).not.toContain('no-restricted-imports')
    })
  })

  describe('check-file/filename-naming-convention: policies and presenters', () => {
    const newGovernedDirectoryCases = [
      {
        label: 'src/policies/',
        validPath: 'src/policies/tenant.policy.ts',
        invalidPath: 'src/policies/tenant.ts',
      },
      {
        label: 'src/presenters/',
        validPath: 'src/presenters/user.presenter.ts',
        invalidPath: 'src/presenters/user.ts',
      },
    ]

    it.each(newGovernedDirectoryCases)(
      'accepts a correctly named file in $label',
      async ({ validPath }) => {
        const ids = await ruleIdsFor(
          validPath,
          '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
        )
        expect(ids).not.toContain('check-file/filename-naming-convention')
      }
    )

    it.each(newGovernedDirectoryCases)(
      'rejects a wrongly named file in $label',
      async ({ invalidPath }) => {
        const messages = await messagesFor(
          invalidPath,
          '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
        )
        const checkFileMessage = messages.find(
          (message) => message.ruleId === 'check-file/filename-naming-convention'
        )
        expect(checkFileMessage?.severity).toBe(2)
      }
    )
  })

  describe('controllers: @typescript-eslint/no-restricted-imports (database/models, type-only)', () => {
    it('rejects a VALUE import from database/models', async () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), 'tests/fixtures/lint-zones/controller-value-imports-model.ts'),
        'utf8'
      )
      const messages = await messagesFor('src/controllers/probe.controller.ts', source)
      const restrictedImportMessage = messages.find(
        (message) => message.ruleId === '@typescript-eslint/no-restricted-imports'
      )
      expect(restrictedImportMessage?.severity).toBe(2)
    })

    it('allows a TYPE-ONLY import of the same module', async () => {
      const source =
        "import type { User } from '@/database/models/user.model'\n\nexport type Probe = User\n"
      const ids = await ruleIdsFor('src/controllers/probe.controller.ts', source)
      expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
    })
  })

  describe('test timing: no bare sleeps under tests/', () => {
    const probePath = 'tests/integration/probe.test.ts'
    const bareSleeps = [
      { label: 'a sleep() call', ruleId: 'no-restricted-syntax', source: 'await sleep(100)\n' },
      {
        label: 'a setTimeout inside new Promise',
        ruleId: 'no-restricted-syntax',
        source: 'await new Promise((resolve) => setTimeout(resolve, 10))\n',
      },
      {
        label: 'a waitForTimeout() call',
        ruleId: 'no-restricted-syntax',
        source: 'await page.waitForTimeout(10)\n',
      },
      {
        label: 'setTimeout from node:timers/promises',
        ruleId: 'no-restricted-imports',
        source: "import { setTimeout } from 'node:timers/promises'\n\nawait setTimeout(10)\n",
      },
      {
        label: 'setTimeout from timers/promises',
        ruleId: 'no-restricted-imports',
        source: "import { setTimeout as delay } from 'timers/promises'\n\nawait delay(10)\n",
      },
    ]

    it.each(bareSleeps)('rejects $label', async ({ ruleId, source }) => {
      const messages = await messagesFor(probePath, source)
      expect(messages.find((message) => message.ruleId === ruleId)?.severity).toBe(2)
    })

    it.each([
      { label: 'settle(ms, reason)', source: "await settle(10, 'absence has no event')\n" },
      {
        label: 'a setImmediate hop',
        source: 'await new Promise((resolve) => setImmediate(resolve))\n',
      },
      { label: 'fake timers', source: 'vi.useFakeTimers()\nsetTimeout(() => undefined, 10)\n' },
    ])('allows $label', async ({ source }) => {
      const ids = await ruleIdsFor(probePath, source)
      expect(ids).not.toContain('no-restricted-syntax')
      expect(ids).not.toContain('no-restricted-imports')
    })

    it('exempts tests/helpers/timing.ts, the one file that defines the waits', async () => {
      const source =
        "import { setTimeout as delay } from 'node:timers/promises'\n\n" +
        'await new Promise((resolve) => setTimeout(resolve, 10))\nawait delay(10)\n'
      const ids = await ruleIdsFor('tests/helpers/timing.ts', source)
      expect(ids).not.toContain('no-restricted-syntax')
      expect(ids).not.toContain('no-restricted-imports')
    })

    it('keeps the timer import ban in tests/helpers/request.ts', async () => {
      const source = "import { setTimeout } from 'node:timers/promises'\n\nawait setTimeout(10)\n"
      const messages = await messagesFor('tests/helpers/request.ts', source)
      expect(messages.find((message) => message.ruleId === 'no-restricted-imports')?.severity).toBe(
        2
      )
    })
  })
})
