/**
 * @file The tax details PATCH body and its cross-field rules. Every
 * validation message a client copies is written out once here, word for
 * word, and asserted on the field it belongs to: the per-field rules through
 * the schemas, the rules across fields through `taxDetailsRuleIssues`.
 */
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import {
  staffTaxDetailsPatchSchema,
  taxDetailsPatchSchema,
  taxDetailsRuleIssues,
  type TaxDetailsValues,
} from '@/validators/tax.validators'

const LEGAL_NAME = 'Enter the legal name to print on your tax invoices.'
const LONGER_THAN_100 = 'Use 100 characters or fewer.'
const LONGER_THAN_60 = 'Use 60 characters or fewer.'
const OUTSIDE_PATTERN = 'Use English letters, digits and common punctuation.'
const GSTIN_SHAPE = 'Enter the 15-character GSTIN, such as 29ABCDE1234F1ZW.'
const GSTIN_CHECKSUM =
  "This GSTIN's last character doesn't match the rest. Check it against your registration certificate."
const GSTIN_STATE = "This GSTIN's first two digits aren't a state code."
const STATE_MISMATCH = 'This GSTIN is registered in Maharashtra. Choose Maharashtra as the state.'
const ADDRESS_NEEDED = 'Enter address line 1. Invoices with a GSTIN need your registered address.'
const CITY_NEEDED = 'Enter the city. Invoices with a GSTIN need it.'
const PINCODE_NEEDED = 'Enter the 6-digit PIN code. Invoices with a GSTIN need it.'
const STATE_REQUIRED =
  'Choose the state of your billing address. It sets the tax split on your invoices.'
const STATE_UNKNOWN = 'Choose a state from the list.'
const PINCODE_FORMAT = 'Enter the 6-digit PIN code.'
const SEZ_NEEDS_GSTIN = 'An SEZ unit has a GSTIN. Enter it first.'
const NO_CHANGE = 'Change at least one tax detail before saving.'

/**
 * The flattened errors of a body the schema refuses.
 * @param body - The body to parse.
 * @param schema - The schema; the owner's by default.
 * @returns The field errors and the form errors.
 */
function errorsOf(
  body: unknown,
  schema: z.ZodType = taxDetailsPatchSchema
): { fieldErrors: Record<string, string[] | undefined>; formErrors: string[] } {
  const result = schema.safeParse(body)
  if (result.success) throw new Error('The schema accepted the body.')
  return z.flattenError(result.error)
}

describe('taxDetailsPatchSchema', () => {
  it('accepts a first save and normalises it', () => {
    expect(
      taxDetailsPatchSchema.parse({
        version: null,
        gstin: ' 29abcde1234f1zw ',
        legalName: '  Acme Traders  ',
        addressLine1: '12 MG Road',
        addressLine2: '  ',
        city: 'Bengaluru',
        pincode: '560001',
        stateCode: '29',
        isSez: false,
      })
    ).toStrictEqual({
      version: null,
      gstin: '29ABCDE1234F1ZW',
      legalName: 'Acme Traders',
      addressLine1: '12 MG Road',
      addressLine2: null,
      city: 'Bengaluru',
      pincode: '560001',
      stateCode: '29',
      isSez: false,
    })
  })

  it('leaves fields not sent out', () => {
    expect(taxDetailsPatchSchema.parse({ version: 3, city: 'Mysuru' })).toStrictEqual({
      version: 3,
      city: 'Mysuru',
    })
  })

  it('reads a blank nullable field as null and a null one as null', () => {
    expect(
      taxDetailsPatchSchema.parse({ version: 1, gstin: ' ', pincode: '', city: null })
    ).toStrictEqual({ version: 1, gstin: null, pincode: null, city: null })
  })

  it('stores curly quotes as straight ones', () => {
    expect(taxDetailsPatchSchema.parse({ version: 1, legalName: 'O’Brien “Ltd”' }).legalName).toBe(
      'O\'Brien "Ltd"'
    )
  })

  it('accepts a legal name that starts with = (the export guards it)', () => {
    expect(taxDetailsPatchSchema.parse({ version: 1, legalName: '=SUM(A1)' }).legalName).toBe(
      '=SUM(A1)'
    )
  })

  it('refuses a blank or null legal name', () => {
    expect(errorsOf({ version: 1, legalName: '   ' }).fieldErrors.legalName).toEqual([LEGAL_NAME])
    expect(errorsOf({ version: 1, legalName: null }).fieldErrors.legalName).toEqual([LEGAL_NAME])
  })

  it.each(['legalName', 'addressLine1', 'addressLine2'])(
    'refuses %s over 100 characters',
    (field) => {
      expect(errorsOf({ version: 1, [field]: 'a'.repeat(101) }).fieldErrors[field]).toEqual([
        LONGER_THAN_100,
      ])
      expect(
        taxDetailsPatchSchema.safeParse({ version: 1, [field]: 'a'.repeat(100) }).success
      ).toBe(true)
    }
  )

  it('refuses a city over 60 characters', () => {
    expect(errorsOf({ version: 1, city: 'a'.repeat(61) }).fieldErrors.city).toEqual([
      LONGER_THAN_60,
    ])
    expect(taxDetailsPatchSchema.safeParse({ version: 1, city: 'a'.repeat(60) }).success).toBe(true)
  })

  it.each(['legalName', 'addressLine1', 'addressLine2', 'city'])(
    'refuses %s in another script',
    (field) => {
      expect(errorsOf({ version: 1, [field]: 'नमस्ते' }).fieldErrors[field]).toEqual([
        OUTSIDE_PATTERN,
      ])
    }
  )

  it('reports only the first rule a text field breaks', () => {
    expect(errorsOf({ version: 1, city: 'न'.repeat(61) }).fieldErrors.city).toHaveLength(1)
    expect(errorsOf({ version: 1, legalName: 'न'.repeat(101) }).fieldErrors.legalName).toHaveLength(
      1
    )
  })

  it('accepts Latin-1 letters', () => {
    expect(taxDetailsPatchSchema.parse({ version: 1, city: 'Zürich' }).city).toBe('Zürich')
  })

  it('names the first GSTIN rule broken', () => {
    expect(errorsOf({ version: 1, gstin: '29ABCDE1234F1' }).fieldErrors.gstin).toEqual([
      GSTIN_SHAPE,
    ])
    expect(errorsOf({ version: 1, gstin: '29ABCDE1234F1ZX' }).fieldErrors.gstin).toEqual([
      GSTIN_CHECKSUM,
    ])
    expect(errorsOf({ version: 1, gstin: '99ABCDE1234F1ZP' }).fieldErrors.gstin).toEqual([
      GSTIN_STATE,
    ])
    expect(errorsOf({ version: 1, gstin: '25ABCDE1234F1Z4' }).fieldErrors.gstin).toEqual([
      GSTIN_STATE,
    ])
    expect(errorsOf({ version: 1, gstin: 42 }).fieldErrors.gstin).toEqual([GSTIN_SHAPE])
  })

  it('refuses a null, blank, retired or unknown state', () => {
    expect(errorsOf({ version: 1, stateCode: null }).fieldErrors.stateCode).toEqual([
      STATE_REQUIRED,
    ])
    expect(errorsOf({ version: 1, stateCode: ' ' }).fieldErrors.stateCode).toEqual([STATE_REQUIRED])
    for (const code of ['25', '28', '99', 'KA'])
      expect(errorsOf({ version: 1, stateCode: code }).fieldErrors.stateCode).toEqual([
        STATE_UNKNOWN,
      ])
  })

  it.each(['012345', '56001', '5600011', 'ABCDEF'])('refuses the PIN code %j', (pincode) => {
    expect(errorsOf({ version: 1, pincode }).fieldErrors.pincode).toEqual([PINCODE_FORMAT])
  })

  it('refuses a body with nothing but the version', () => {
    expect(errorsOf({ version: 1 }).formErrors).toEqual([NO_CHANGE])
    expect(errorsOf({ version: null }).formErrors).toEqual([NO_CHANGE])
  })

  it('refuses an unknown key', () => {
    expect(errorsOf({ version: 1, city: 'Mysuru', gstState: '29' }).formErrors).not.toEqual([])
  })

  it('refuses a missing or malformed version', () => {
    expect(errorsOf({ city: 'Mysuru' }).fieldErrors.version).toBeDefined()
    expect(errorsOf({ version: 0, city: 'Mysuru' }).fieldErrors.version).toBeDefined()
  })

  it('refuses a reason from the owner', () => {
    expect(errorsOf({ version: 1, city: 'Mysuru', reason: 'Fix' }).formErrors).not.toEqual([])
  })
})

describe('staffTaxDetailsPatchSchema', () => {
  it('takes a reason with the change', () => {
    expect(
      staffTaxDetailsPatchSchema.parse({ version: 2, city: 'Mysuru', reason: 'Customer asked' })
    ).toStrictEqual({ version: 2, city: 'Mysuru', reason: 'Customer asked' })
  })

  it('needs a reason', () => {
    expect(
      errorsOf({ version: 2, city: 'Mysuru' }, staffTaxDetailsPatchSchema).fieldErrors.reason
    ).toBeDefined()
  })

  it('does not count the reason as a change', () => {
    expect(
      errorsOf({ version: 2, reason: 'Customer asked' }, staffTaxDetailsPatchSchema).formErrors
    ).toEqual([NO_CHANGE])
  })
})

describe('taxDetailsRuleIssues', () => {
  const registered: TaxDetailsValues = {
    gstin: '29ABCDE1234F1ZW',
    legalName: 'Acme Traders',
    addressLine1: '12 MG Road',
    addressLine2: null,
    city: 'Bengaluru',
    pincode: '560001',
    stateCode: '29',
    isSez: false,
  }

  it('passes a consistent row', () => {
    expect(taxDetailsRuleIssues(registered, new Set(['gstin', 'stateCode', 'isSez']))).toEqual([])
  })

  it('puts a GSTIN in another state on the state, naming that state', () => {
    const merged = { ...registered, gstin: '27ABCDE1234F1Z0' }
    expect(taxDetailsRuleIssues(merged, new Set(['gstin']))).toEqual([
      { field: 'stateCode', message: STATE_MISMATCH },
    ])
    expect(taxDetailsRuleIssues(merged, new Set(['stateCode']))).toHaveLength(1)
  })

  it('skips the state match unless the GSTIN or the state was sent', () => {
    const merged = { ...registered, gstin: '27ABCDE1234F1Z0' }
    expect(taxDetailsRuleIssues(merged, new Set(['city']))).toEqual([])
  })

  it('refuses a stored GSTIN whose prefix is no longer a state, on the GSTIN, when the state rule runs', () => {
    const merged = { ...registered, gstin: '25ABCDE1234F1Z4', stateCode: '27' }
    expect(taxDetailsRuleIssues(merged, new Set(['stateCode']))).toEqual([
      { field: 'gstin', message: GSTIN_STATE },
    ])
    expect(taxDetailsRuleIssues(merged, new Set(['city']))).toEqual([])
  })

  it('needs the address, city and PIN code with a GSTIN, each on its own field', () => {
    const merged = { ...registered, addressLine1: null, city: null, pincode: null }
    expect(taxDetailsRuleIssues(merged, new Set(['gstin']))).toEqual([
      { field: 'addressLine1', message: ADDRESS_NEEDED },
      { field: 'city', message: CITY_NEEDED },
      { field: 'pincode', message: PINCODE_NEEDED },
    ])
    expect(taxDetailsRuleIssues(merged, new Set(['city']))).toHaveLength(3)
    expect(taxDetailsRuleIssues(merged, new Set(['legalName']))).toEqual([])
  })

  it('needs no address without a GSTIN', () => {
    const merged = { ...registered, gstin: null, addressLine1: null, city: null, pincode: null }
    expect(taxDetailsRuleIssues(merged, new Set(['gstin', 'addressLine1']))).toEqual([])
  })

  it('needs a GSTIN for an SEZ unit', () => {
    const merged = { ...registered, gstin: null, isSez: true }
    expect(taxDetailsRuleIssues(merged, new Set(['gstin']))).toEqual([
      { field: 'isSez', message: SEZ_NEEDS_GSTIN },
    ])
    expect(taxDetailsRuleIssues(merged, new Set(['isSez']))).toHaveLength(1)
    expect(taxDetailsRuleIssues(merged, new Set(['city']))).toEqual([])
  })
})
