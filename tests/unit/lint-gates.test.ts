// tests/unit/lint-gates.test.ts
//
// These assert that the lint gates FIRE, not that the config file contains
// certain keys. A gate that is configured but inert lints green while enforcing
// nothing, which is worse than having no gate — it happened three times while
// Task 2 was being written.
import { ESLint, type Linter } from 'eslint'
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
// fatals before any rule runs. None of the five rules exercised via
// lintText need type information, so this second instance disables the
// type-checked rule set to get a clean, non-fatal parse instead.
const eslintText = new ESLint({
  cwd: process.cwd(),
  ignore: false,
  // `disableTypeChecked` is a single flat-config object at runtime (verified:
  // Array.isArray is false), not an array — pass it as-is rather than
  // casting to Linter.Config[], which would misrepresent its actual shape.
  overrideConfig: tseslint.configs.disableTypeChecked as Linter.Config,
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

describe('lint gates actually fire', () => {
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

  it('accepts a correctly named file in a governed directory', async () => {
    const ids = await ruleIdsFor(
      'src/controllers/user.controller.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    expect(ids).not.toContain('check-file/filename-naming-convention')
  })

  it('rejects a wrongly named file in a governed directory', async () => {
    const messages = await messagesFor(
      'src/controllers/user.ts',
      '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
    )
    const checkFileMessage = messages.find(
      (message) => message.ruleId === 'check-file/filename-naming-convention'
    )
    expect(checkFileMessage?.severity).toBe(2)
  })

  it('allows process.env inside env.config and blocks it elsewhere', async () => {
    const source = 'export const x = process.env.FOO\n'
    expect(await ruleIdsFor('src/configs/env.config.ts', source)).not.toContain(
      'no-restricted-properties'
    )
    expect(await ruleIdsFor('src/services/other.service.ts', source)).toContain(
      'no-restricted-properties'
    )
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

  // no-cycle CANNOT be tested through lintText. import-x builds its ExportMap by
  // reading real files with fs.readFileSync, and the rule bails out when the
  // filename is the synthetic `<text>`. It needs files that exist on disk, which
  // is why these fixtures are committed rather than generated inline.
  //
  // TWO fixtures, not one, and the second is the one that matters. The bug
  // documented in eslint.config.mjs's `import-x/resolver-next` comment — a
  // cwd-relative tsconfig `configFile` — breaks no-cycle for ALIASED ("@/")
  // imports only: the resolver hands back a relative path, which never ===
  // the absolute `physicalFilename` the rule compares against. Plain
  // relative "./b" imports resolve absolutely either way and keep firing.
  // So a regression test built solely on the relative fixture stays green in
  // exactly the state it exists to prevent — verified by reverting the fix
  // and watching the relative case still pass. Both cases are pinned.
  it('rejects a circular import between real files (relative import)', async () => {
    const results = await eslint.lintFiles(['tests/fixtures/lint-cycle/a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })

  it('rejects a circular import between real files (aliased "@/" import)', async () => {
    const results = await eslint.lintFiles(['src/lint-fixtures/cycle-a.ts'])
    const messages = results[0]?.messages ?? []
    const cycleMessage = messages.find((message) => message.ruleId === 'import-x/no-cycle')
    expect(cycleMessage?.severity).toBe(2)
  })
})
