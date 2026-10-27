/**
 * @file The GST seller config and its boot checks take crafted envs, never
 * the memoised getEnv().
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { gstSellerConfig } from '@/configs/billing.config'
import { assertEnvConsistent } from '@/configs/env-consistency.config'
import { parseEnv } from '@/configs/env.config'
import { TAX_TEXT_PATTERN, normaliseQuotes } from '@/utilities/gst.utilities'

const base: Record<string, string> = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
}

const seller: Record<string, string> = {
  BILLING_GST_REGISTERED: 'true',
  BILLING_SELLER_GSTIN: '29AABCE1234F1Z1',
  BILLING_SELLER_LEGAL_NAME: 'Acme Software Pvt Ltd',
  BILLING_SELLER_ADDRESS: '1 MG Road | Bengaluru 560001',
  BILLING_SELLER_STATE_CODE: '29',
  BILLING_SAC_CODE: '998314',
  BILLING_GST_EFFECTIVE_FROM: '2026-04-01',
}

/**
 * Parse the base env plus the given raw variables.
 */
function env(extra: Record<string, string>): ReturnType<typeof parseEnv> {
  return parseEnv({ ...base, ...extra })
}

/**
 * Run the boot checks; returns the thrown message and every warning.
 */
function runChecks(extra: Record<string, string>): {
  error: string | undefined
  warnings: string[]
} {
  const warn = vi.fn<(message: string) => void>()
  let message: string | undefined
  try {
    assertEnvConsistent(env(extra), warn)
  } catch (error) {
    message = (error as Error).message
  }
  return { error: message, warnings: warn.mock.calls.map(([w]) => w) }
}

describe('gstSellerConfig', () => {
  it('is null with registration off and nothing set, and boot passes without a warning', () => {
    expect(gstSellerConfig(env({}))).toBeNull()
    expect(runChecks({})).toStrictEqual({ error: undefined, warnings: [] })
  })

  it('builds the config with the effective date at 00:00 IST and the address split', () => {
    const config = gstSellerConfig(env(seller))
    expect(config).not.toBeNull()
    expect(config?.effectiveFrom.toISOString()).toBe('2026-03-31T18:30:00.000Z')
    expect(config?.addressLines).toStrictEqual(['1 MG Road', 'Bengaluru 560001'])
    expect(config).toMatchObject({
      gstin: '29AABCE1234F1Z1',
      legalName: 'Acme Software Pvt Ltd',
      stateCode: '29',
      sacCode: '998314',
      invoicePrefix: 'INV',
      creditNotePrefix: 'CN',
    })
    expect(runChecks(seller)).toStrictEqual({ error: undefined, warnings: [] })
  })

  it.each([
    'BILLING_SELLER_GSTIN',
    'BILLING_SELLER_LEGAL_NAME',
    'BILLING_SELLER_ADDRESS',
    'BILLING_SELLER_STATE_CODE',
    'BILLING_SAC_CODE',
    'BILLING_GST_EFFECTIVE_FROM',
  ])('names %s when registration is on and it is missing', (name) => {
    const { [name]: _removed, ...rest } = seller
    const { error } = runChecks(rest)
    expect(error).toContain(name)
  })

  it('refuses a GSTIN whose state differs from the state code', () => {
    const { error } = runChecks({ ...seller, BILLING_SELLER_STATE_CODE: '27' })
    expect(error).toContain(
      'BILLING_SELLER_GSTIN is registered in state 29 but BILLING_SELLER_STATE_CODE is 27. Set them to the same state.'
    )
  })

  it('refuses BILLING_EINVOICE_REQUIRED=true', () => {
    const { error } = runChecks({ ...seller, BILLING_EINVOICE_REQUIRED: 'true' })
    expect(error).toContain('BILLING_EINVOICE_REQUIRED is true')
    expect(error).toContain('turn off BILLING_GST_REGISTERED')
  })

  it('refuses equal prefixes', () => {
    const { error } = runChecks({
      ...seller,
      BILLING_INVOICE_PREFIX: 'INV',
      BILLING_CREDIT_NOTE_PREFIX: 'INV',
    })
    expect(error).toContain('BILLING_INVOICE_PREFIX')
  })

  it('rejects a prefix longer than four characters', () => {
    expect(() => env({ BILLING_INVOICE_PREFIX: 'INVOI' })).toThrow()
  })

  it('rejects a seller name in Devanagari', () => {
    expect(() => env({ ...seller, BILLING_SELLER_LEGAL_NAME: 'नमस्ते' })).toThrow()
  })

  it('stores a curly apostrophe straight', () => {
    const config = gstSellerConfig(env({ ...seller, BILLING_SELLER_LEGAL_NAME: 'O’Brien Traders' }))
    expect(config?.legalName).toBe("O'Brien Traders")
  })

  it('rejects a GSTIN with a bad checksum or a bad state code', () => {
    expect(() => env({ ...seller, BILLING_SELLER_GSTIN: '29ABCDE1234F1ZX' })).toThrow()
    expect(() => env({ ...seller, BILLING_SELLER_STATE_CODE: '99' })).toThrow()
  })

  it('warns once when seller variables are set with registration off', () => {
    const { BILLING_GST_REGISTERED: _on, ...rest } = seller
    const { error, warnings } = runChecks(rest)
    expect(error).toBeUndefined()
    const matching = warnings.filter((w) => w.includes('BILLING_GST_REGISTERED is false'))
    expect(matching).toHaveLength(1)
    expect(matching[0]).toContain('so no tax documents are issued.')
  })
})

describe('TAX_TEXT_PATTERN', () => {
  it('refuses C1 controls and accepts NBSP, e-acute and y-diaeresis', () => {
    expect(TAX_TEXT_PATTERN.test('\u0085')).toBe(false)
    expect(TAX_TEXT_PATTERN.test('\u009F')).toBe(false)
    expect(TAX_TEXT_PATTERN.test(' ')).toBe(true)
    expect(TAX_TEXT_PATTERN.test('é')).toBe(true)
    expect(TAX_TEXT_PATTERN.test('ÿ')).toBe(true)
  })

  it('is written with escapes only', () => {
    const source = readFileSync('src/utilities/gst.utilities.ts', 'utf8')
    const line = source.split('\n').find((l) => l.includes('TAX_TEXT_PATTERN ='))
    expect(line).toBeDefined()
    expect([...(line ?? '')].every((ch) => (ch.codePointAt(0) ?? 0) < 128)).toBe(true)
  })

  it('normaliseQuotes straightens curly quotes', () => {
    expect(normaliseQuotes('‘a’ “b”')).toBe('\'a\' "b"')
  })
})
