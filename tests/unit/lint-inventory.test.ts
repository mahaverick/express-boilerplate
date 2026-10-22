/**
 * @file Pins every lint rule to the linter the migration audit assigned it.
 * tests/fixtures/lint-inventory.json lists each origin/main rule exactly
 * once: Oxlint runs it, ESLint keeps it, it was dropped, or Oxlint turns it
 * off. A rule that vanishes in a later edit (moved, mistyped or overridden
 * off at the top level) fails a case below that names it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vite-plus/test'

/**
 * The audited rule lists. Oxlint names use the `plugin/rule` form; the
 * eslint and dropped lists keep their ESLint names.
 */
interface LintInventory {
  oxlint: string[]
  eslint: string[]
  dropped: string[]
  off: string[]
}

/**
 * A rule value in either linter's config: a severity, or a severity
 * followed by options.
 */
type RuleValue = string | number | [string | number, ...unknown[]]

const inventory = JSON.parse(
  fs.readFileSync(path.resolve('tests/fixtures/lint-inventory.json'), 'utf8')
) as LintInventory

/**
 * The slice of vite.config.ts this file reads.
 */
interface ViteConfigWithLint {
  lint?: { rules?: Record<string, RuleValue> }
}

/**
 * vite.config.ts, imported by path so tsc does not pull it into the
 * typecheck project, which rejects its `.ts` import extension.
 */
const viteConfigPath = path.resolve('vite.config.ts')
const { default: viteConfig } = (await import(viteConfigPath)) as { default: ViteConfigWithLint }

/**
 * The top-level Oxlint rules. Overrides may only narrow these, so they are
 * not read here.
 */
const oxlintRules = viteConfig.lint?.rules ?? {}

/**
 * Normalises a rule value to ESLint's numeric severity: 0 off, 1 warn,
 * 2 error.
 * @param value - The rule's configured value.
 * @returns The numeric severity.
 */
function severityOf(value: RuleValue): number {
  const level = Array.isArray(value) ? value[0] : value
  if (level === 'error' || level === 'deny' || level === 2) return 2
  if (level === 'warn' || level === 1) return 1
  return 0
}

/**
 * Lists the top-level Oxlint rule keys at the given severity.
 * @param severity - 0 for off, 2 for error.
 * @returns The rule keys, in config order.
 */
function oxlintKeysAt(severity: number): string[] {
  return Object.entries(oxlintRules)
    .filter(([, value]) => severityOf(value) === severity)
    .map(([key]) => key)
}

describe('lint inventory', () => {
  it('lists every rule exactly once', () => {
    const all = [...inventory.oxlint, ...inventory.eslint, ...inventory.dropped, ...inventory.off]
    const repeated = all.filter((rule, index) => all.indexOf(rule) !== index)
    expect(repeated, `rules listed more than once: ${repeated.join(', ')}`).toEqual([])
  })

  it('enables every rule the inventory assigns to oxlint, at error', () => {
    const enabled = new Set(oxlintKeysAt(2))
    const missing = inventory.oxlint.filter((rule) => !enabled.has(rule))
    expect(missing, `oxlint rules not enabled at error: ${missing.join(', ')}`).toEqual([])
  })

  it('enables nothing the inventory does not list', () => {
    const listed = new Set(inventory.oxlint)
    const extra = oxlintKeysAt(2).filter((rule) => !listed.has(rule))
    expect(extra, `oxlint rules enabled but not in the inventory: ${extra.join(', ')}`).toEqual([])
  })

  it('turns off exactly the inventory off list', () => {
    const off = new Set(oxlintKeysAt(0))
    const missing = inventory.off.filter((rule) => !off.has(rule))
    expect(
      missing,
      `rules the inventory turns off but oxlint does not: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('keeps every eslint-listed rule in eslint.config.mjs', async () => {
    const eslint = new ESLint({ cwd: process.cwd() })
    // The controller path covers the controllers-only type-import ban.
    const probes = ['src/app.ts', 'src/controllers/probe.controller.ts', 'tests/unit/probe.test.ts']
    const configs = await Promise.all(probes.map((file) => eslint.calculateConfigForFile(file)))
    const missing = inventory.eslint.filter(
      (rule) =>
        !configs.some((config: { rules?: Record<string, RuleValue> }) => {
          const value = config.rules?.[rule]
          return value !== undefined && severityOf(value) === 2
        })
    )
    expect(missing, `eslint rules not at severity 2: ${missing.join(', ')}`).toEqual([])
  })
})
