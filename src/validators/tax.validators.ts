/**
 * @file The tax details PATCH body, for owners and staff, and the rules
 * across its fields. A PATCH sends only the fields that changed plus the
 * `version` it read; each sent field is checked here on its own, and the
 * cross-field rules run in the service on the stored row with the sent
 * fields applied (`taxDetailsRuleIssues`).
 */
import { z } from 'zod'
import {
  GSTIN_CHECKSUM_MESSAGE,
  GSTIN_SHAPE_MESSAGE,
  GSTIN_STATE_MESSAGE,
  gstinStateMismatchMessage,
  TAX_ADDRESS_REQUIRED_MESSAGE,
  TAX_CITY_REQUIRED_MESSAGE,
  TAX_CITY_TOO_LONG_MESSAGE,
  TAX_DETAILS_NO_CHANGE_MESSAGE,
  TAX_LEGAL_NAME_REQUIRED_MESSAGE,
  TAX_PINCODE_FORMAT_MESSAGE,
  TAX_PINCODE_REQUIRED_MESSAGE,
  TAX_SEZ_NEEDS_GSTIN_MESSAGE,
  TAX_STATE_REQUIRED_MESSAGE,
  TAX_STATE_UNKNOWN_MESSAGE,
  TAX_TEXT_CHARACTERS_MESSAGE,
  TAX_TEXT_TOO_LONG_MESSAGE,
} from '@/constants/billing.constants'
import { TAX_DETAIL_FIELDS, type TaxDetailField } from '@/constants/gst.constants'
import {
  gstinProblem,
  normaliseGstin,
  normaliseQuotes,
  stateOf,
  TAX_TEXT_PATTERN,
} from '@/utilities/gst.utilities'
import { versionSchema } from '@/validators/platform-billing.validators'
import { reasonSchema } from '@/validators/platform.validators'

/**
 * The longest legal name or address line, the columns' width.
 */
const TAX_TEXT_MAX_LENGTH = 100

/**
 * The longest city, the column's width.
 */
const TAX_CITY_MAX_LENGTH = 60

/**
 * A PIN code: six digits, the first not zero.
 */
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/

/**
 * What each GSTIN problem reads.
 */
const GSTIN_PROBLEM_MESSAGES = {
  shape: GSTIN_SHAPE_MESSAGE,
  checksum: GSTIN_CHECKSUM_MESSAGE,
  state: GSTIN_STATE_MESSAGE,
} as const

/**
 * Reads a blank string as null, so a cleared nullable field stores null.
 * @param value - The raw value.
 * @returns Null for a blank string, else the value unchanged.
 */
function blankToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value
}

/**
 * A text field the invoice prints: trimmed, curly quotes made straight, then
 * held to the characters the PDF font draws and to its column's width.
 * @param max - The longest value.
 * @param tooLong - What a longer value reads.
 * @param wrongType - What a value that isn't text reads.
 * @returns The schema.
 */
function taxText(max: number, tooLong: string, wrongType: string) {
  return z
    .string({ error: wrongType })
    .trim()
    .overwrite(normaliseQuotes)
    .regex(TAX_TEXT_PATTERN, TAX_TEXT_CHARACTERS_MESSAGE)
    .max(max, tooLong)
}

/**
 * A nullable text field: blank or null clears it.
 * @param max - The longest value.
 * @param tooLong - What a longer value reads.
 * @returns The schema.
 */
function nullableTaxText(max: number, tooLong: string) {
  return z.preprocess(blankToNull, taxText(max, tooLong, TAX_TEXT_CHARACTERS_MESSAGE).nullable())
}

/**
 * The fields of a tax details PATCH, each optional and checked on its own.
 */
const taxDetailsShape = {
  version: versionSchema.nullable(),
  gstin: z
    .preprocess(
      blankToNull,
      z
        .string({ error: GSTIN_SHAPE_MESSAGE })
        .overwrite(normaliseGstin)
        .superRefine((gstin, context) => {
          const problem = gstinProblem(gstin)
          if (problem !== null) {
            context.addIssue({ code: 'custom', message: GSTIN_PROBLEM_MESSAGES[problem] })
          }
        })
        .nullable()
    )
    .optional(),
  legalName: taxText(
    TAX_TEXT_MAX_LENGTH,
    TAX_TEXT_TOO_LONG_MESSAGE,
    TAX_LEGAL_NAME_REQUIRED_MESSAGE
  )
    .min(1, TAX_LEGAL_NAME_REQUIRED_MESSAGE)
    .optional(),
  addressLine1: nullableTaxText(TAX_TEXT_MAX_LENGTH, TAX_TEXT_TOO_LONG_MESSAGE).optional(),
  addressLine2: nullableTaxText(TAX_TEXT_MAX_LENGTH, TAX_TEXT_TOO_LONG_MESSAGE).optional(),
  city: nullableTaxText(TAX_CITY_MAX_LENGTH, TAX_CITY_TOO_LONG_MESSAGE).optional(),
  pincode: z
    .preprocess(
      blankToNull,
      z
        .string({ error: TAX_PINCODE_FORMAT_MESSAGE })
        .trim()
        .regex(PINCODE_PATTERN, TAX_PINCODE_FORMAT_MESSAGE)
        .nullable()
    )
    .optional(),
  stateCode: z
    .string({ error: TAX_STATE_REQUIRED_MESSAGE })
    .trim()
    .superRefine((code, context) => {
      if (code === '') context.addIssue({ code: 'custom', message: TAX_STATE_REQUIRED_MESSAGE })
      else if (stateOf(code) === undefined) {
        context.addIssue({ code: 'custom', message: TAX_STATE_UNKNOWN_MESSAGE })
      }
    })
    .optional(),
  isSez: z.boolean().optional(),
}

/**
 * Whether a body sends at least one tax details field; `version` and a
 * staff `reason` don't count.
 * @param body - The parsed body.
 * @returns True when a field was sent.
 */
function hasDetailField(body: Partial<Record<TaxDetailField, unknown>>): boolean {
  return TAX_DETAIL_FIELDS.some((field) => body[field] !== undefined)
}

/**
 * `PATCH /tenants/:slug/billing/tax-details`: the changed fields and the
 * `version` read, null for the first save. An unknown key is refused.
 */
export const taxDetailsPatchSchema = z
  .strictObject(taxDetailsShape)
  .refine(hasDetailField, { message: TAX_DETAILS_NO_CHANGE_MESSAGE })

/**
 * The staff PATCH of a workspace's tax details: the owner's body plus why.
 */
export const staffTaxDetailsPatchSchema = z
  .strictObject({ ...taxDetailsShape, reason: reasonSchema })
  .refine(hasDetailField, { message: TAX_DETAILS_NO_CHANGE_MESSAGE })

/**
 * A validated tax details PATCH: the version and the fields sent.
 */
export type TaxDetailsPatch = z.infer<typeof taxDetailsPatchSchema>

/**
 * A workspace's stored tax details under their PATCH names.
 */
export interface TaxDetailsValues {
  gstin: string | null
  legalName: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  pincode: string | null
  stateCode: string
  isSez: boolean
}

/**
 * One refusal of a rule across fields, on the field it names.
 */
export interface TaxDetailsRuleIssue {
  field: TaxDetailField
  message: string
}

/**
 * The fields a GSTIN makes required, with what each reads when missing.
 */
const GSTIN_REQUIRED_FIELDS = [
  ['addressLine1', TAX_ADDRESS_REQUIRED_MESSAGE],
  ['city', TAX_CITY_REQUIRED_MESSAGE],
  ['pincode', TAX_PINCODE_REQUIRED_MESSAGE],
] as const

/**
 * The rules across tax details fields, run on the stored row with the sent
 * fields applied. Each runs only when the body sent a field it names, so a
 * stored value that today's rules refuse never blocks an unrelated
 * correction: the GSTIN's state is the chosen state (checked only when the
 * GSTIN starts with a selectable state code); a GSTIN needs address line 1,
 * the city and the PIN code; an SEZ unit needs a GSTIN.
 * @param merged - The details as they would be saved.
 * @param sent - The fields the body sent.
 * @returns Each broken rule on its field; empty when all pass.
 */
export function taxDetailsRuleIssues(
  merged: TaxDetailsValues,
  sent: ReadonlySet<TaxDetailField>
): TaxDetailsRuleIssue[] {
  const issues: TaxDetailsRuleIssue[] = []
  const { gstin } = merged
  if (gstin !== null && (sent.has('gstin') || sent.has('stateCode'))) {
    const gstinState = stateOf(gstin.slice(0, 2))
    if (gstinState !== undefined && gstinState.code !== merged.stateCode) {
      issues.push({ field: 'stateCode', message: gstinStateMismatchMessage(gstinState.name) })
    }
  }
  const sentAddressRule = ['gstin', 'addressLine1', 'city', 'pincode'] as const
  if (gstin !== null && sentAddressRule.some((field) => sent.has(field))) {
    for (const [field, message] of GSTIN_REQUIRED_FIELDS) {
      if (merged[field] === null) issues.push({ field, message })
    }
  }
  if (merged.isSez && gstin === null && (sent.has('isSez') || sent.has('gstin'))) {
    issues.push({ field: 'isSez', message: TAX_SEZ_NEEDS_GSTIN_MESSAGE })
  }
  return issues
}
