/**
 * @file These assert that the lint gates FIRE, not that the config file
 * contains certain keys. A gate that is configured but inert lints green
 * while enforcing nothing, which is worse than having no gate at all. Each
 * gate is probed through the tool that owns its rule: Oxlint
 * (vite.config.ts) through tests/helpers/oxlint-probe.ts, and the rules
 * ESLint still runs (eslint.config.mjs) through `lintText`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ESLint, type Linter } from 'eslint'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import {
  oxlintMessagesFor,
  registerOxlintProbe,
  runOxlintProbes,
  UNUSED_DIRECTIVE_RULE_ID,
} from '../helpers/oxlint-probe'

/**
 * Lints with the repo's real ESLint config, `ignore: false` so a committed
 * fixture under tests/fixtures/ can be linted deliberately here while
 * `pnpm lint` keeps skipping it. The config is untyped, so synthetic text at
 * a path that isn't on disk lints like a real file.
 */
const eslint = new ESLint({ cwd: process.cwd(), ignore: false })

/**
 * Lints `source` at a synthetic `filePath` via {@link eslint}; the path
 * selects the config and need not exist. Returns the lint messages.
 * @throws {Error} When ESLint fatals on `source`. A fatal reports with
 *   `ruleId: null`, which a caller mapping to `ruleId ?? ''` would silently
 *   read as "no rule fired", turning a `not.toContain` assertion into a
 *   vacuous pass. That is exactly the inert-gate failure mode this file
 *   exists to catch, so it fails loudly instead.
 */
const messagesFor = async (filePath: string, source: string): Promise<Linter.LintMessage[]> => {
  const [result] = await eslint.lintText(source, { filePath })
  const messages = result?.messages ?? []
  const fatal = messages.find((message) => message.fatal)
  if (fatal) throw new Error(`eslint fataled on ${filePath}: ${fatal.message}`)
  return messages
}

/**
 * The rule id of each message {@link messagesFor} reported for `source` at
 * `filePath`, `''` for a fatal.
 */
const ruleIdsFor = async (filePath: string, source: string): Promise<string[]> => {
  const messages = await messagesFor(filePath, source)
  return messages.map((message) => message.ruleId ?? '')
}

/** A committed fixture's text. */
const readFixture = (fixture: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), fixture), 'utf8')

/**
 * The rule id of each finding Oxlint reports for `source` at `filePath`.
 */
const oxlintRuleIdsFor = async (filePath: string, source: string): Promise<string[]> => {
  const messages = await oxlintMessagesFor(filePath, source)
  return messages.map((message) => message.ruleId)
}

/** Oxlint's id for the restricted-import bans: platform repositories and timer sleeps. */
const RESTRICTED_IMPORTS = 'eslint/no-restricted-imports'
/** Oxlint's id for the process.env and console bans. */
const RESTRICTED_PROPERTIES = 'eslint/no-restricted-properties'
/** Oxlint's id for the unused-variable rule. */
const UNUSED_VARS = 'eslint/no-unused-vars'
/** Oxlint's id for the import-cycle rule. */
const NO_CYCLE = 'import/no-cycle'

/**
 * This suite's own timeout, for each test and the `beforeAll` batch, in place
 * of the global one. The worst whole-file run measured was 7.1 s (load
 * average 17); this is 10x that, rounded up, per CLAUDE.md's test timing rule 3.
 */
const LINT_GATE_TIMEOUT_MS = 75_000

describe('lint gates actually fire', { timeout: LINT_GATE_TIMEOUT_MS }, () => {
  // Every Oxlint probe below registers while the file is collected; this lints them all in one batch.
  beforeAll(runOxlintProbes, LINT_GATE_TIMEOUT_MS)

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

  /** One accepts/rejects pair per governed directory. */
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

  const processEnvSource = 'export const x = process.env.FOO\n'
  const consoleErrorSource = 'export function f(): void { console.error("x") }\n'
  const consoleInfoSource = 'export function f(): void { console.info("x") }\n'
  for (const filePath of ['src/configs/env.config.ts', 'src/services/other.service.ts']) {
    registerOxlintProbe(filePath, processEnvSource)
  }
  for (const filePath of [
    'src/services/logger.service.ts',
    'src/index.ts',
    'src/services/other.service.ts',
  ]) {
    registerOxlintProbe(filePath, consoleErrorSource)
  }
  for (const filePath of ['src/observability/tracing.ts', 'src/observability/other.ts']) {
    registerOxlintProbe(filePath, processEnvSource)
    registerOxlintProbe(filePath, consoleInfoSource)
  }

  it('allows process.env inside env.config and blocks it elsewhere', async () => {
    expect(await oxlintRuleIdsFor('src/configs/env.config.ts', processEnvSource)).not.toContain(
      RESTRICTED_PROPERTIES
    )
    expect(await oxlintRuleIdsFor('src/services/other.service.ts', processEnvSource)).toContain(
      RESTRICTED_PROPERTIES
    )
  })

  it('allows console.error inside logger.service.ts and index.ts but blocks it elsewhere', async () => {
    expect(
      await oxlintRuleIdsFor('src/services/logger.service.ts', consoleErrorSource)
    ).not.toContain(RESTRICTED_PROPERTIES)
    expect(await oxlintRuleIdsFor('src/index.ts', consoleErrorSource)).not.toContain(
      RESTRICTED_PROPERTIES
    )
    expect(await oxlintRuleIdsFor('src/services/other.service.ts', consoleErrorSource)).toContain(
      RESTRICTED_PROPERTIES
    )
  })

  // tracing.ts loads via `--import` before getEnv() has run, so like env.config.ts/logger.service.ts/index.ts it may read process.env directly and use console.*; the exemption is scoped to this one filename, not the whole directory.
  it('allows process.env and console.* inside tracing.ts but blocks them in a sibling file', async () => {
    expect(await oxlintRuleIdsFor('src/observability/tracing.ts', processEnvSource)).not.toContain(
      RESTRICTED_PROPERTIES
    )
    expect(await oxlintRuleIdsFor('src/observability/tracing.ts', consoleInfoSource)).not.toContain(
      RESTRICTED_PROPERTIES
    )
    expect(await oxlintRuleIdsFor('src/observability/other.ts', processEnvSource)).toContain(
      RESTRICTED_PROPERTIES
    )
    expect(await oxlintRuleIdsFor('src/observability/other.ts', consoleInfoSource)).toContain(
      RESTRICTED_PROPERTIES
    )
  })

  it('does not enforce filename-naming-convention under src/observability/', async () => {
    const ids = await ruleIdsFor(
      'src/observability/tracing.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('check-file/filename-naming-convention')
  })

  // Express identifies an error handler by arity (four parameters); `response` is used in the body (matching a real handler), so the rule's "after-used" default alone would not exempt the unused fourth — only the underscore prefix does.
  const underscoreParameterSource =
    'export function h(error: unknown, request: unknown, response: { end: () => void }, _next: unknown): void { response.end() }\n'
  const unusedParameterSource =
    'export function h(error: unknown, request: unknown, response: { end: () => void }, next: unknown): void { response.end() }\n'
  registerOxlintProbe('src/middlewares/probe.middleware.ts', underscoreParameterSource)
  registerOxlintProbe('src/middlewares/probe-unused.middleware.ts', unusedParameterSource)

  it('allows a deliberately-unused underscore-prefixed handler parameter', async () => {
    const ids = await oxlintRuleIdsFor(
      'src/middlewares/probe.middleware.ts',
      underscoreParameterSource
    )
    expect(ids).not.toContain(UNUSED_VARS)
  })

  it('still rejects a genuinely-unused parameter with no underscore', async () => {
    // If this does not fire, argsIgnorePattern has become a blanket suppression rather than an opt-in convention.
    const messages = await oxlintMessagesFor(
      'src/middlewares/probe-unused.middleware.ts',
      unusedParameterSource
    )
    const unusedVariablesMessage = messages.find((message) => message.ruleId === UNUSED_VARS)
    expect(unusedVariablesMessage?.severity).toBe(2)
  })

  const relativeCycleFixture = 'tests/fixtures/lint-cycle/a.ts'
  const aliasedCycleFixture = 'tests/fixtures/lint-cycle/cycle-a.ts'
  const authCycleSource =
    "import { requireAuth } from '@/middlewares/auth.middleware'\n\nexport const x = requireAuth\n"
  registerOxlintProbe(relativeCycleFixture, readFixture(relativeCycleFixture))
  registerOxlintProbe(aliasedCycleFixture, readFixture(aliasedCycleFixture))
  registerOxlintProbe('src/constants/auth.constants.ts', authCycleSource)

  // Oxlint follows a probe's imports through the copied src/ and fixtures; this proves the rule fires at all, on a relative import.
  it('rejects a circular import between real files (relative import)', async () => {
    const messages = await oxlintMessagesFor(
      relativeCycleFixture,
      readFixture(relativeCycleFixture)
    )
    const cycleMessage = messages.find((message) => message.ruleId === NO_CYCLE)
    expect(cycleMessage?.severity).toBe(2)
  })

  // Resolves "@/" through the fixture's own tsconfig, the nearest one Oxlint finds, so this does NOT guard the root tsconfig's alias; only the real-config case below does.
  it('rejects a circular import between real files (aliased "@/" import, own local tsconfig)', async () => {
    const messages = await oxlintMessagesFor(aliasedCycleFixture, readFixture(aliasedCycleFixture))
    const cycleMessage = messages.find((message) => message.ruleId === NO_CYCLE)
    expect(cycleMessage?.severity).toBe(2)
  })

  // The one case that guards the root tsconfig's "@/*" alias as Oxlint resolves it: auth.middleware.ts imports auth.constants.ts, so an auth.constants.ts that imports auth.middleware closes a real cycle through the alias.
  it('rejects a circular "@/" import resolved by the real config', async () => {
    const messages = await oxlintMessagesFor('src/constants/auth.constants.ts', authCycleSource)
    const cycleMessage = messages.find((message) => message.ruleId === NO_CYCLE)
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
    const fixtureSource = readFixture(fixture)
    const relativeSource =
      "import { PlatformTenantRepository } from './platform-tenant.repository'\n\n" +
      'export const repository = PlatformTenantRepository\n'
    const rejectPaths = [
      'src/services/tenant.service.ts',
      'src/services/audit.service.ts',
      'src/middlewares/probe.middleware.ts',
      'src/repositories/probe-tenant.repository.ts',
    ]
    for (const syntheticPath of rejectPaths) registerOxlintProbe(syntheticPath, fixtureSource)
    registerOxlintProbe('src/repositories/probe-tenant.repository.ts', relativeSource)
    registerOxlintProbe('src/services/platform-tenant.service.ts', fixtureSource)

    it.each(rejectPaths)('rejects an import from %s', async (syntheticPath) => {
      const messages = await oxlintMessagesFor(syntheticPath, fixtureSource)
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const messages = await oxlintMessagesFor(
        'src/repositories/probe-tenant.repository.ts',
        relativeSource
      )
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const ids = await oxlintRuleIdsFor('src/services/platform-tenant.service.ts', fixtureSource)
      expect(ids).not.toContain(RESTRICTED_IMPORTS)
    })
  })

  describe('no-restricted-imports: repositories/platform-stats.repository', () => {
    const fixture = 'tests/fixtures/lint-zones/service-imports-platform-stats-repository.ts'
    const fixtureSource = readFixture(fixture)
    const relativeSource =
      "import { PlatformStatsRepository } from './platform-stats.repository'\n\n" +
      'export const repository = PlatformStatsRepository\n'
    const rejectPaths = [
      'src/services/tenant.service.ts',
      'src/services/audit.service.ts',
      'src/middlewares/probe.middleware.ts',
      'src/repositories/probe-stats.repository.ts',
    ]
    for (const syntheticPath of rejectPaths) registerOxlintProbe(syntheticPath, fixtureSource)
    registerOxlintProbe('src/repositories/probe-stats.repository.ts', relativeSource)
    registerOxlintProbe('src/services/platform-stats.service.ts', fixtureSource)

    it.each(rejectPaths)('rejects an import from %s', async (syntheticPath) => {
      const messages = await oxlintMessagesFor(syntheticPath, fixtureSource)
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const messages = await oxlintMessagesFor(
        'src/repositories/probe-stats.repository.ts',
        relativeSource
      )
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const ids = await oxlintRuleIdsFor('src/services/platform-stats.service.ts', fixtureSource)
      expect(ids).not.toContain(RESTRICTED_IMPORTS)
    })
  })

  describe('no-restricted-imports: repositories/platform-user.repository', () => {
    const fixture = 'tests/fixtures/lint-zones/service-imports-platform-user-repository.ts'
    const fixtureSource = readFixture(fixture)
    const relativeSource =
      "import { PlatformUserRepository } from './platform-user.repository'\n\n" +
      'export const repository = PlatformUserRepository\n'
    const rejectPaths = [
      'src/services/profile.service.ts',
      'src/services/auth.service.ts',
      'src/controllers/probe.controller.ts',
      'src/repositories/probe-user.repository.ts',
    ]
    for (const syntheticPath of rejectPaths) registerOxlintProbe(syntheticPath, fixtureSource)
    registerOxlintProbe('src/repositories/probe-user.repository.ts', relativeSource)
    registerOxlintProbe('src/services/platform-user.service.ts', fixtureSource)

    it.each(rejectPaths)('rejects an import from %s', async (syntheticPath) => {
      const messages = await oxlintMessagesFor(syntheticPath, fixtureSource)
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const messages = await oxlintMessagesFor(
        'src/repositories/probe-user.repository.ts',
        relativeSource
      )
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const ids = await oxlintRuleIdsFor('src/services/platform-user.service.ts', fixtureSource)
      expect(ids).not.toContain(RESTRICTED_IMPORTS)
    })
  })

  describe('no-restricted-imports: repositories/platform-email.repository', () => {
    const fixture = 'tests/fixtures/lint-zones/service-imports-platform-email-repository.ts'
    const fixtureSource = readFixture(fixture)
    const relativeSource =
      "import { PlatformEmailRepository } from './platform-email.repository'\n\n" +
      'export const repository = PlatformEmailRepository\n'
    const rejectPaths = [
      'src/services/email-webhook.service.ts',
      'src/services/mailer.service.ts',
      'src/controllers/probe.controller.ts',
      'src/repositories/probe-email.repository.ts',
    ]
    for (const syntheticPath of rejectPaths) registerOxlintProbe(syntheticPath, fixtureSource)
    registerOxlintProbe('src/repositories/probe-email.repository.ts', relativeSource)
    registerOxlintProbe('src/services/platform-email.service.ts', fixtureSource)

    it.each(rejectPaths)('rejects an import from %s', async (syntheticPath) => {
      const messages = await oxlintMessagesFor(syntheticPath, fixtureSource)
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const messages = await oxlintMessagesFor(
        'src/repositories/probe-email.repository.ts',
        relativeSource
      )
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const ids = await oxlintRuleIdsFor('src/services/platform-email.service.ts', fixtureSource)
      expect(ids).not.toContain(RESTRICTED_IMPORTS)
    })
  })

  describe('no-restricted-imports: repositories/platform-onboarding.repository', () => {
    const fixture = 'tests/fixtures/lint-zones/service-imports-platform-onboarding-repository.ts'
    const fixtureSource = readFixture(fixture)
    const relativeSource =
      "import { PlatformOnboardingRepository } from './platform-onboarding.repository'\n\n" +
      'export const repository = PlatformOnboardingRepository\n'
    const rejectPaths = [
      'src/services/onboarding.service.ts',
      'src/services/tenant.service.ts',
      'src/controllers/probe.controller.ts',
      'src/repositories/probe-onboarding.repository.ts',
    ]
    for (const syntheticPath of rejectPaths) registerOxlintProbe(syntheticPath, fixtureSource)
    registerOxlintProbe('src/repositories/probe-onboarding.repository.ts', relativeSource)
    registerOxlintProbe('src/services/platform-onboarding.service.ts', fixtureSource)

    it.each(rejectPaths)('rejects an import from %s', async (syntheticPath) => {
      const messages = await oxlintMessagesFor(syntheticPath, fixtureSource)
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('rejects a relative import of the same module', async () => {
      const messages = await oxlintMessagesFor(
        'src/repositories/probe-onboarding.repository.ts',
        relativeSource
      )
      const restricted = messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)
      expect(restricted?.severity).toBe(2)
    })

    it('allows services/platform-*.service.ts', async () => {
      const ids = await oxlintRuleIdsFor(
        'src/services/platform-onboarding.service.ts',
        fixtureSource
      )
      expect(ids).not.toContain(RESTRICTED_IMPORTS)
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
      {
        label: 'a sleep() call',
        lint: messagesFor,
        ruleId: 'no-restricted-syntax',
        source: 'await sleep(100)\n',
      },
      {
        label: 'a setTimeout inside new Promise',
        lint: messagesFor,
        ruleId: 'no-restricted-syntax',
        source: 'await new Promise((resolve) => setTimeout(resolve, 10))\n',
      },
      {
        label: 'a waitForTimeout() call',
        lint: messagesFor,
        ruleId: 'no-restricted-syntax',
        source: 'await page.waitForTimeout(10)\n',
      },
      {
        label: 'setTimeout from node:timers/promises',
        lint: oxlintMessagesFor,
        ruleId: RESTRICTED_IMPORTS,
        source: "import { setTimeout } from 'node:timers/promises'\n\nawait setTimeout(10)\n",
      },
      {
        label: 'setTimeout from timers/promises',
        lint: oxlintMessagesFor,
        ruleId: RESTRICTED_IMPORTS,
        source: "import { setTimeout as delay } from 'timers/promises'\n\nawait delay(10)\n",
      },
    ]

    const allowedWaits = [
      { label: 'settle(ms, reason)', source: "await settle(10, 'absence has no event')\n" },
      {
        label: 'a setImmediate hop',
        source: 'await new Promise((resolve) => setImmediate(resolve))\n',
      },
      { label: 'fake timers', source: 'vi.useFakeTimers()\nsetTimeout(() => undefined, 10)\n' },
    ]
    const timingSource =
      "import { setTimeout as delay } from 'node:timers/promises'\n\n" +
      'await new Promise((resolve) => setTimeout(resolve, 10))\nawait delay(10)\n'
    const timerImportSource =
      "import { setTimeout } from 'node:timers/promises'\n\nawait setTimeout(10)\n"
    for (const { lint, source } of bareSleeps) {
      if (lint === oxlintMessagesFor) registerOxlintProbe(probePath, source)
    }
    for (const { source } of allowedWaits) registerOxlintProbe(probePath, source)
    registerOxlintProbe('tests/helpers/timing.ts', timingSource)
    registerOxlintProbe('tests/helpers/request.ts', timerImportSource)

    it.each(bareSleeps)('rejects $label', async ({ lint, ruleId, source }) => {
      const messages = await lint(probePath, source)
      expect(messages.find((message) => message.ruleId === ruleId)?.severity).toBe(2)
    })

    it.each(allowedWaits)('allows $label', async ({ source }) => {
      expect(await ruleIdsFor(probePath, source)).not.toContain('no-restricted-syntax')
      expect(await oxlintRuleIdsFor(probePath, source)).not.toContain(RESTRICTED_IMPORTS)
    })

    it('exempts tests/helpers/timing.ts, the one file that defines the waits', async () => {
      expect(await ruleIdsFor('tests/helpers/timing.ts', timingSource)).not.toContain(
        'no-restricted-syntax'
      )
      expect(await oxlintRuleIdsFor('tests/helpers/timing.ts', timingSource)).not.toContain(
        RESTRICTED_IMPORTS
      )
    })

    it('keeps the timer import ban in tests/helpers/request.ts', async () => {
      const messages = await oxlintMessagesFor('tests/helpers/request.ts', timerImportSource)
      expect(messages.find((message) => message.ruleId === RESTRICTED_IMPORTS)?.severity).toBe(2)
    })
  })

  /**
   * Oxlint reads only oxlint-* directives (respectEslintDisableDirectives:
   * false), so each tool checks its own blanket disables.
   */
  describe('disable directives', () => {
    const probePath = 'src/services/probe.service.ts'
    const blanketOxlintSource = '/* oxlint-disable */\nexport const a = 1\n'
    const unusedDirectiveSource =
      '// oxlint-disable-next-line eslint/no-console -- probe\nexport const a = 1\n'
    registerOxlintProbe(probePath, blanketOxlintSource)
    registerOxlintProbe(probePath, unusedDirectiveSource)

    it('rejects a blanket eslint-disable', async () => {
      const messages = await messagesFor(probePath, '/* eslint-disable */\nexport const a = 1\n')
      const abusive = messages.find(
        (message) => message.ruleId === 'unicorn/no-abusive-eslint-disable'
      )
      expect(abusive?.severity).toBe(2)
    })

    it('rejects a blanket oxlint-disable', async () => {
      const messages = await oxlintMessagesFor(probePath, blanketOxlintSource)
      const abusive = messages.find(
        (message) => message.ruleId === 'unicorn/no-abusive-eslint-disable'
      )
      expect(abusive?.severity).toBe(2)
    })

    it('rejects an eslint-disable that suppresses nothing, as an error', async () => {
      const source =
        '// eslint-disable-next-line no-restricted-syntax -- probe\nexport const a = 1\n'
      const messages = await messagesFor(probePath, source)
      const unused = messages.find(
        (message) => message.ruleId === null && message.message.startsWith('Unused eslint-disable')
      )
      expect(unused?.severity).toBe(2)
    })

    it('rejects an oxlint-disable that suppresses nothing', async () => {
      const messages = await oxlintMessagesFor(probePath, unusedDirectiveSource)
      const unused = messages.find((message) => message.ruleId === UNUSED_DIRECTIVE_RULE_ID)
      expect(unused?.severity).toBe(2)
    })
  })

  describe('the Oxlint probe helper', () => {
    it.each(['../outside.ts', '/outside.ts', 'src/../../outside.ts'])(
      'refuses the path %s, outside the lint scope',
      (filePath) => {
        expect(() => registerOxlintProbe(filePath, 'export {}\n')).toThrow(/outside the lint scope/)
      }
    )

    it('fails on a probe that was never registered', async () => {
      await expect(
        oxlintMessagesFor('src/services/never.service.ts', 'export {}\n')
      ).rejects.toThrow(/not registered/)
    })
  })

  describe('raw SQL: sql.raw and .unsafe outside models', () => {
    const rawSql = "import { sql } from 'drizzle-orm'\nexport const q = sql.raw('select 1')\n"

    it('rejects sql.raw in a service', async () => {
      const messages = await messagesFor('src/services/probe.service.ts', rawSql)
      expect(messages.find((message) => message.ruleId === 'no-restricted-syntax')?.severity).toBe(
        2
      )
    })

    it('rejects .unsafe( in a utility', async () => {
      const source =
        "declare const client: { unsafe: (query: string) => unknown }\nclient.unsafe('select 1')\n"
      const messages = await messagesFor('src/utilities/probe.utilities.ts', source)
      expect(messages.find((message) => message.ruleId === 'no-restricted-syntax')?.severity).toBe(
        2
      )
    })

    it.each([
      {
        label: 'a string literal passed to execute',
        source:
          "declare const db: { execute: (query: string) => unknown }\ndb.execute('select 1')\n",
      },
      {
        label: 'an untagged template passed to execute',
        source:
          'declare const db: { execute: (query: string) => unknown }\ndeclare const id: string\ndb.execute(`select ${id}`)\n',
      },
      {
        label: 'a concatenation passed to execute',
        source:
          "declare const db: { execute: (query: string) => unknown }\ndeclare const id: string\ndb.execute('select ' + id)\n",
      },
      {
        label: "sql['raw'], a computed member",
        source: "import { sql } from 'drizzle-orm'\nexport const q = sql['raw']('select 1')\n",
      },
      {
        label: 'sql.raw taken as a value',
        source:
          "import { sql } from 'drizzle-orm'\nconst raw = sql.raw\nexport const q = raw('select 1')\n",
      },
      {
        label: 'sql imported under an alias',
        source: "import { sql as s } from 'drizzle-orm'\nexport const q = s.raw('select 1')\n",
      },
      {
        label: 'sql imported under an alias from a drizzle-orm subpath',
        source:
          "import { sql as s } from 'drizzle-orm/pg-core'\nexport const q = s.raw('select 1')\n",
      },
      {
        label: 'sql rebound to another name',
        source:
          "import { sql } from 'drizzle-orm'\nconst s = sql\nexport const q = s.raw('select 1')\n",
      },
      {
        label: 'raw destructured from sql',
        source:
          "import { sql } from 'drizzle-orm'\nconst { raw } = sql\nexport const q = raw('select 1')\n",
      },
      {
        label: 'raw read off a namespace import',
        source: "import * as orm from 'drizzle-orm'\nexport const q = orm.sql.raw('select 1')\n",
      },
      {
        label: 'an SQL object built with its constructor',
        source: "import { SQL } from 'drizzle-orm'\nexport const q = new SQL([])\n",
      },
      {
        label: 'a StringChunk built with its constructor',
        source:
          "import { StringChunk } from 'drizzle-orm'\nexport const q = new StringChunk('select 1')\n",
      },
      {
        label: 'raw taken by assignment destructuring',
        source:
          "import { sql } from 'drizzle-orm'\nlet raw: unknown\n;({ raw } = sql)\nexport const q = raw\n",
      },
      {
        label: 'raw renamed by assignment destructuring',
        source:
          "import { sql } from 'drizzle-orm'\nlet r: unknown\n;({ raw: r } = sql)\nexport const q = r\n",
      },
      {
        label: 'a String(...) call passed to execute',
        source:
          'declare const db: { execute: (query: string) => unknown }\ndeclare const id: string\ndb.execute(String(id))\n',
      },
    ])('rejects $label in a service', async ({ source }) => {
      const messages = await messagesFor('src/services/probe.service.ts', source)
      expect(messages.find((message) => message.ruleId === 'no-restricted-syntax')?.severity).toBe(
        2
      )
    })

    it('allows a tagged sql template passed to execute, the shape src uses', async () => {
      const source =
        "import { sql } from 'drizzle-orm'\n" +
        'declare const tx: { execute: (query: unknown) => unknown }\n' +
        'declare const id: string\n' +
        'tx.execute(sql`select ${id}`)\n'
      const ids = await ruleIdsFor('src/services/probe.service.ts', source)
      expect(ids).not.toContain('no-restricted-syntax')
    })

    it.each([
      'src/database/models/probe.model.ts',
      'src/repositories/platform-onboarding.repository.ts',
      'src/utilities/list-page.utilities.ts',
      'src/repositories/email-message.repository.ts',
    ])('allows it in %s', async (filePath) => {
      const ids = await ruleIdsFor(filePath, rawSql)
      expect(ids).not.toContain('no-restricted-syntax')
    })

    it('does not apply under tests/', async () => {
      // No bare sleep here, so a no-restricted-syntax hit could only come from the SQL selectors.
      const ids = await ruleIdsFor('tests/integration/probe.test.ts', rawSql)
      expect(ids).not.toContain('no-restricted-syntax')
    })
  })
})
