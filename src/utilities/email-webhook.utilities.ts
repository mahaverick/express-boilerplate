/**
 * @file Pure helpers every email webhook adapter shares: comparing a
 * signature in constant time, and normalising a Message-ID header.
 */
import { timingSafeEqual } from 'node:crypto'

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
