/**
 * @file The copy for zod's own messages: what a field error says when its
 * schema sets no message of its own. zod's defaults ("Invalid input:
 * expected string, received undefined") reach a person as `errors.<field>`,
 * so this module replaces them, once, for the whole process. A message a
 * schema sets itself still wins: zod reads this map only when there is none.
 * `parse.validators.ts` imports it, so it is in place before any request is
 * parsed.
 */
import { z } from 'zod'

/**
 * What to enter, by the type zod expected.
 */
const EXPECTED_TYPE_MESSAGES: Readonly<Record<string, string>> = {
  string: 'Enter text.',
  number: 'Enter a number.',
  int: 'Enter a whole number.',
  bigint: 'Enter a whole number.',
  boolean: 'Choose true or false.',
  array: 'Enter a list.',
  object: 'Enter a set of fields.',
  date: 'Enter a date.',
}

/**
 * What to enter, by the string format zod checked.
 */
const FORMAT_MESSAGES: Readonly<Record<string, string>> = {
  email: 'Enter an email address, such as ada@example.com.',
  uuid: 'Enter a 36-character ID.',
  guid: 'Enter a 36-character ID.',
  url: 'Enter a web address that starts with https://.',
  datetime: 'Enter a date and time, such as 2026-10-20T15:42:00Z.',
  date: 'Enter a date, such as 2026-10-20.',
}

/**
 * The fallback for any issue no rule below names.
 */
const CHECK_VALUE_MESSAGE = 'Check this value, then try again.'

/**
 * A count with its unit, singular for 1.
 * @param count - How many.
 * @param unit - The unit's singular form.
 * @returns For example "1 item" or "3 items".
 */
function counted(count: number | bigint, unit: string): string {
  const units = Number(count) === 1 ? unit : `${unit}s`
  return `${String(count)} ${units}`
}

/**
 * The message for a value under its minimum.
 * @param issue - The `too_small` issue.
 * @returns The message.
 */
function tooSmallMessage(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooSmall>): string {
  const { minimum, origin } = issue
  if (origin === 'string') {
    return Number(minimum) === 1
      ? 'Enter a value.'
      : `Enter at least ${counted(minimum, 'character')}.`
  }
  if (origin === 'array' || origin === 'set') return `Add at least ${counted(minimum, 'item')}.`
  return `Enter ${String(minimum)} or more.`
}

/**
 * The message for a value over its maximum.
 * @param issue - The `too_big` issue.
 * @returns The message.
 */
function tooBigMessage(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooBig>): string {
  const { maximum, origin } = issue
  if (origin === 'string') return `Enter ${counted(maximum, 'character')} or fewer.`
  if (origin === 'array' || origin === 'set') return `Use ${counted(maximum, 'item')} or fewer.`
  return `Enter ${String(maximum)} or less.`
}

/**
 * The person-facing message for one zod issue that carries no message of its
 * own.
 * @param issue - The raw issue zod raises.
 * @returns The message.
 */
function zodIssueMessage(issue: z.core.$ZodRawIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Enter a value.'
      return EXPECTED_TYPE_MESSAGES[issue.expected] ?? CHECK_VALUE_MESSAGE
    }
    case 'invalid_format': {
      return FORMAT_MESSAGES[issue.format] ?? 'Check the format of this value, then try again.'
    }
    case 'too_small': {
      return tooSmallMessage(issue)
    }
    case 'too_big': {
      return tooBigMessage(issue)
    }
    case 'invalid_value': {
      return `Choose one of: ${issue.values.map(String).join(', ')}.`
    }
    case 'unrecognized_keys': {
      const fields = issue.keys.length === 1 ? 'the field' : 'the fields'
      return `Remove ${fields} this request does not accept: ${issue.keys.join(', ')}.`
    }
    case 'not_multiple_of': {
      return `Enter a multiple of ${String(issue.divisor)}.`
    }
    default: {
      return CHECK_VALUE_MESSAGE
    }
  }
}

z.config({ customError: zodIssueMessage })
