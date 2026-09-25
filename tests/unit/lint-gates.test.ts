// tests/unit/lint-gates.test.ts
//
// These assert that the lint gates FIRE, not that the config file contains
// certain keys. A gate that is configured but inert lints green while enforcing
// nothing, which is worse than having no gate — it happened three times while
// Task 2 was being written.
import fs from 'node:fs'
import path from 'node:path'
import { ESLint, type Linter } from 'eslint'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

// `ignore: false` so the committed cycle fixtures under tests/fixtures/ can be
// linted deliberately here while `pnpm lint` keeps skipping them. This
// instance uses the repo's real config (type-aware parserOptions.project),
// which is required for the no-cycle case below: its fixtures are real,
// committed files that the type-aware project can resolve.
const eslint = new ESLint({ cwd: process.cwd(), ignore: false })

// lintText's `filePath` below is synthetic — none of these paths exist on
// disk. Under `parserOptions.project` (see eslint.config.mjs — needed so
// type-aware rules can see tests/, unlike the old `projectService: true`),
// typescript-eslint resolves included files through a real tsconfig watch
// program rather than the projectService's "any open file" model, so a path
// that isn't really on disk is "not included in any tsconfig" and lint
// fatals before any rule runs. None of the rules exercised via lintText
// need type information, so this second instance disables the type-checked
// rule set to get a clean, non-fatal parse instead.
const eslintText = new ESLint({
  cwd: process.cwd(),
  ignore: false,
  // `disableTypeChecked` is a single flat-config object at runtime (verified:
  // Array.isArray is false), not an array — pass it as-is rather than
  // casting to Linter.Config[], which would misrepresent its actual shape.
  overrideConfig: tseslint.configs.disableTypeChecked as Linter.Config,
})

// The aliased lint-cycle fixture (tests/fixtures/lint-cycle/cycle-a.ts)
// imports "@/cycle-b", which the repo's default project and resolver (root
// tsconfig.json, "@/*" -> "./src/*") cannot see. That fixture's own
// tsconfig.json maps "@/*" to "./*" instead, and this instance points BOTH
// the type-aware parser's project AND the resolver's tsconfig at it.
// Overriding only one of the two either fatals (the parser finds the file in
// no project) or leaves no-cycle silently unable to resolve the aliased
// import.
const aliasedCycleTsconfig = path.join(process.cwd(), 'tests/fixtures/lint-cycle/tsconfig.json')
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

const messagesFor = async (filePath: string, source: string): Promise<Linter.LintMessage[]> => {
  const [result] = await eslintText.lintText(source, { filePath })
  const messages = result?.messages ?? []
  // A fatal parse error reports with `ruleId: null`, which a caller mapping
  // to `ruleId ?? ''` would silently read as "no rule fired" — turning the
  // three `not.toContain` assertions below into vacuous passes. Fail loudly
  // instead: that is exactly the inert-gate failure mode this file exists
  // to catch.
  const fatal = messages.find((message) => message.fatal)
  if (fatal) throw new Error(`eslint fataled on ${filePath}: ${fatal.message}`)
  return messages
}

const ruleIdsFor = async (filePath: string, source: string): Promise<string[]> => {
  const messages = await messagesFor(filePath, source)
  return messages.map((message) => message.ruleId ?? '')
}

// This suite gets its own timeout instead of the global 20s (vitest.config.ts),
// which stays right for every other file.
//
// Measured on an idle machine, per test: 1101ms for the first `lintText`
// (ESLint config resolution plus parser init) and 1474ms for the first
// `lintFiles` (typescript-eslint building the real TS program the no-cycle
// fixtures need). Every later test in each group costs 7-40ms, because both
// ESLint instances above are module-scoped and reused — so the file is ~4s
// end to end, comfortably inside 20s.
//
// It is the VARIANCE that made this file flaky, not the mean. Run
// immediately after `pnpm lint && pnpm build` — which is exactly the
// sequence CI runs — those same two cold tests were observed at 20.2s and
// once at 61s: eight vitest workers, v8 coverage instrumentation, and a
// just-finished `tsc` all compete for the CPU while ESLint type-checks the
// project from cold. A 229ms overrun was enough to fail a run.
//
// A gate test that flakes is worse than a slow one: it gets labelled flaky,
// then skipped, and the thing this file proves — that the lint gates
// actually FIRE rather than merely being configured — is this repository's
// most valuable single test. So the timeout is generous (2x the worst
// contended run ever observed here) rather than tuned close to the mean.
// Raising the GLOBAL timeout instead was rejected: that would hide a real
// slowdown anywhere else in the suite.
const LINT_GATE_TIMEOUT_MS = 120_000

describe('lint gates actually fire', { timeout: LINT_GATE_TIMEOUT_MS }, () => {
  it('rejects an undocumented export', async () => {
    const messages = await messagesFor(
      'src/utilities/probe.utilities.ts',
      'export function p(): string { return "x" }\n'
    )
    const jsdocMessage = messages.find((message) => message.ruleId === 'jsdoc/require-jsdoc')
    // Checking severity, not just presence, so a gate silently downgraded to
    // "warn" (which still lints green under --max-warnings unset, and would
    // still pass a bare `toContain` check) is also caught.
    expect(jsdocMessage?.severity).toBe(2)
  })

  it('accepts a documented export', async () => {
    const ids = await ruleIdsFor(
      'src/utilities/probe.utilities.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('jsdoc/require-jsdoc')
  })

  // Parameterized (sonarjs/parameterized-tests) rather than one it() pair per
  // directory: three near-identical "accepts"/"rejects" pairs tripped the
  // rule once src/jobs/ and src/workers/ joined src/controllers/ as a third
  // governed-directory case — this is that rule's own fix, not a workaround.
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

  // tracing.ts loads via `--import`, before getEnv() has ever run, so it is
  // the one other module (alongside env.config.ts/logger.service.ts/index.ts
  // above) allowed to read process.env directly and to use console.* instead
  // of the logger — both for the same load-order reason. A sibling file
  // under the same directory must NOT inherit the exemption: it is scoped to
  // this one filename, not the whole src/observability/ directory.
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
    // Express identifies an error handler by arity (four parameters); the
    // fourth is almost never used. `response` is used in the body (matching
    // a real handler) so the rule's "after-used" default does not itself
    // exempt every parameter — only the underscore prefix does.
    const source =
      'export function h(error: unknown, request: unknown, response: { end: () => void }, _next: unknown): void { response.end() }\n'
    const ids = await ruleIdsFor('src/middlewares/probe.middleware.ts', source)
    expect(ids).not.toContain('@typescript-eslint/no-unused-vars')
  })

  it('still rejects a genuinely-unused parameter with no underscore', async () => {
    // If this does not fire, argsIgnorePattern has become a blanket
    // suppression rather than an opt-in convention — worse than no rule.
    const source =
      'export function h(error: unknown, request: unknown, response: { end: () => void }, next: unknown): void { response.end() }\n'
    const messages = await messagesFor('src/middlewares/probe.middleware.ts', source)
    const unusedVariablesMessage = messages.find(
      (message) => message.ruleId === '@typescript-eslint/no-unused-vars'
    )
    expect(unusedVariablesMessage?.severity).toBe(2)
  })

  // no-cycle follows imports through real files on disk (import-x reads
  // them with fs.readFileSync), so every case below starts from, or leads
  // back to, a file that really exists. Three cases, each guarding one
  // thing:
  //
  // - relative fixture (a.ts/b.ts): the rule fires at all.
  // - aliased fixture (cycle-a.ts/cycle-b.ts): the rule follows a "@/"
  //   alias. It runs under its own resolver and tsconfig, so it does NOT
  //   guard eslint.config.mjs's resolver settings.
  // - real src/ edge through the REAL config: the one that guards
  //   eslint.config.mjs's `import-x/resolver-next`. A cwd-relative
  //   tsconfig `configFile` there makes "@/*" imports resolve to relative
  //   paths, which never === the absolute `physicalFilename` no-cycle
  //   compares against, so no-cycle stops firing on aliased imports while
  //   still firing on relative ones. Only this case goes red when that
  //   happens.
  it('rejects a circular import between real files (relative import)', async () => {
    const results = await eslint.lintFiles(['tests/fixtures/lint-cycle/a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  it('rejects a circular import between real files (aliased "@/" import, own local tsconfig)', async () => {
    const results = await eslintAliasedCycle.lintFiles(['tests/fixtures/lint-cycle/cycle-a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  // auth.middleware.ts imports auth.constants.ts, so linting auth.constants.ts
  // with an import of auth.middleware closes a real cycle through the "@/"
  // alias, resolved by eslint.config.mjs's own resolver.
  it('rejects a circular "@/" import resolved by the real config', async () => {
    const source =
      "import { requireAuth } from '@/middlewares/auth.middleware'\n\nexport const x = requireAuth\n"
    const messages = await messagesFor('src/constants/auth.constants.ts', source)
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  // Each zone is linted through lintText at a SYNTHETIC path inside the
  // zone's target directory: import-x/no-restricted-paths matches a zone on
  // the linted file's own path, so a fixture linted where it physically
  // lives (tests/fixtures/) would never match a src/ target. The imported
  // module is resolved for real, so every fixture imports a file that
  // exists.
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

    // The controllers zone has two `from` paths (repositories, and
    // services/database.service); the fixture above exercises only the
    // first. This exercises the second, inline since it is one line.
    it('rejects: controllers must not import services/database.service', async () => {
      const source =
        "import { db } from '@/services/database.service'\n\nexport const client = db\n"
      const messages = await messagesFor('src/controllers/probe.controller.ts', source)
      const zoneMessage = messages.find(
        (message) => message.ruleId === 'import-x/no-restricted-paths'
      )
      expect(zoneMessage?.severity).toBe(2)
    })

    // The controllers-to-controllers zone excepts the two shared modules
    // every controller builds on. Without the exception every real
    // controller would fail the zone.
    it('allows a controller to import base.controller and helpers.controller', async () => {
      const source =
        "import { BaseController } from '@/controllers/base.controller'\n" +
        "import { authenticatedUserId } from '@/controllers/helpers.controller'\n\n" +
        'export const shared = [BaseController, authenticatedUserId]\n'
      const ids = await ruleIdsFor('src/controllers/probe.controller.ts', source)
      expect(ids).not.toContain('import-x/no-restricted-paths')
    })

    // Negative control: the same import that fires from src/controllers/
    // must not fire from an unrelated layer, or the zone would be matching
    // on the import alone rather than on the (target, from) pair.
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
})
