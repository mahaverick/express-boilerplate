/**
 * @file Pure helpers the email webhook adapters share: comparing a
 * signature in constant time, normalising a Message-ID header, and turning a
 * provider's reason code into a storable `detail`.
 */
import { timingSafeEqual } from 'node:crypto'
import { EMAIL_DETAIL_MAX_LENGTH, EMAIL_DETAIL_PATTERN } from '@/constants/email.constants'

/**
 * The widest Message-ID header an event may carry, the width of
 * `email_messages.message_id_header`.
 */
const MESSAGE_ID_HEADER_MAX_LENGTH = 255

/**
 * Whether two signatures are byte-for-byte equal, in time that depends only
 * on their length. `timingSafeEqual` throws on a length mismatch, so the
 * lengths, which are public, are compared first.
 * @param expected - The signature computed over the body.
 * @param received - A signature the request carried.
 * @returns True only for identical bytes.
 */
export function isSameSignature(expected: Buffer, received: Buffer): boolean {
  return expected.length === received.length && timingSafeEqual(expected, received)
}

/**
 * A provider's Message-ID value in the form `email_messages.message_id_header`
 * stores it: trimmed, inside one pair of angle brackets.
 * @param value - The value from the payload.
 * @returns `<id@domain>`, or undefined when there is no usable value.
 */
export function normalizedMessageIdHeader(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const header = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`
  if (header === '<>' || header.length > MESSAGE_ID_HEADER_MAX_LENGTH) return undefined
  return header
}

/**
 * An all-hex run, the shape a token takes once upper-cased.
 */
const HEX_RUN = /^[\dA-F]{16,}$/

/**
 * Whether a character is an ASCII upper-case letter.
 * @param character - One character, or undefined past either end.
 * @returns True for A to Z.
 */
function isUpper(character: string | undefined): boolean {
  return character !== undefined && character >= 'A' && character <= 'Z'
}

/**
 * Split one alphanumeric run at its camel-case boundaries: before a capital
 * that follows a lower-case letter or digit (`Message|Rejected`), and before
 * a capital that follows a capital and precedes a lower-case letter
 * (`SMTP|Error`). A loop, not a regex, so no input can backtrack.
 * @param chunk - Letters and digits only.
 * @returns The words, in order.
 */
function camelWords(chunk: string): string[] {
  const words: string[] = []
  let start = 0
  for (let index = 1; index < chunk.length; index += 1) {
    if (!isUpper(chunk[index])) continue
    const next = chunk[index + 1]
    const isLowerNext = next !== undefined && next >= 'a' && next <= 'z'
    if (!isLowerNext && isUpper(chunk[index - 1])) continue
    words.push(chunk.slice(start, index))
    start = index
  }
  words.push(chunk.slice(start))
  return words
}

/**
 * A provider's reason code (Resend's `bounce.subType`, `MessageRejected`) as
 * the UPPER_SNAKE `detail` `email_events` stores (`MESSAGE_REJECTED`), or
 * nothing. A value that does not fit `EMAIL_DETAIL_PATTERN` and
 * `EMAIL_DETAIL_MAX_LENGTH` once converted is dropped rather than cut, and
 * so is an all-hex run of 16 or more characters, so a token-shaped value
 * never reaches the column.
 * @param value - The provider's code.
 * @returns The UPPER_SNAKE code, or undefined.
 */
export function upperSnakeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const words = value
    .split(/[^A-Za-z\d]+/)
    .flatMap((chunk) => camelWords(chunk))
    .filter((word) => word.length > 0)
  const detail = words.join('_').toUpperCase()
  if (detail.length > EMAIL_DETAIL_MAX_LENGTH || !EMAIL_DETAIL_PATTERN.test(detail)) {
    return undefined
  }
  return HEX_RUN.test(detail) ? undefined : detail
}
