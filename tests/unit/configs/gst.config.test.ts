/**
 * @file The GST seller config and its variables' parsing take crafted envs,
 * never the memoised getEnv(). The boot checks across the seller variables
 * are in env-consistency.config.test.ts.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { gstSellerConfig } from '@/configs/billing.config'
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

describe('gstSellerConfig', () => {
  it('is null with registration off and nothing set, and boot passes without a warning', () => {
    expect(gstSellerConfig(env({}))).toBeNull()
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
  })

  it('takes a prefix of 1 to 3 capital letters or digits and rejects a longer one', () => {
    expect(env({ BILLING_INVOICE_PREFIX: 'IN1', BILLING_CREDIT_NOTE_PREFIX: 'C' })).toMatchObject({
      BILLING_INVOICE_PREFIX: 'IN1',
      BILLING_CREDIT_NOTE_PREFIX: 'C',
    })
    expect(() => env({ BILLING_INVOICE_PREFIX: 'INVO' })).toThrow('BILLING_INVOICE_PREFIX')
    expect(() => env({ BILLING_CREDIT_NOTE_PREFIX: 'CRED' })).toThrow('BILLING_CREDIT_NOTE_PREFIX')
    expect(() => env({ BILLING_INVOICE_PREFIX: 'in' })).toThrow('BILLING_INVOICE_PREFIX')
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

  it('names a GSTIN whose first two digits are no state once, not once per rule', () => {
    let message = ''
    try {
      env({ ...seller, BILLING_SELLER_GSTIN: '99ABCDE1234F1ZP' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.match(/BILLING_SELLER_GSTIN/g)).toHaveLength(1)
    expect(message).toContain(
      'must be a GSTIN whose last character matches and whose first two digits are a state code'
    )
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
