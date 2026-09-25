// tests/unit/readme-env-table.test.ts
//
// README's environment table is generated from the schema's describe() text.
// This pins that every schema variable has a row, that no row names a
// variable the schema dropped, and that no renamed name survives in README.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOVED_ENV_NAMES } from '@/configs/env-consistency.config'
import { EnvSchemaShape } from '@/configs/env.config'

const readme = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8')
const rowNames = Array.from(readme.matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm), (match) => match[1])
const schemaNames = Object.keys(EnvSchemaShape)

describe('README environment table', () => {
  it.each(schemaNames)('has a row for %s', (name) => {
    expect(rowNames).toContain(name)
  })

  it('has no row for a variable the schema does not define', () => {
    expect(rowNames.filter((name) => name !== undefined && !schemaNames.includes(name))).toEqual([])
  })

  it('lists each variable once', () => {
    expect(new Set(rowNames).size).toBe(rowNames.length)
  })

  it.each(Object.keys(REMOVED_ENV_NAMES))('never mentions the removed name %s', (name) => {
    expect(readme).not.toMatch(new RegExp(String.raw`\b${name}\b`))
  })
})
