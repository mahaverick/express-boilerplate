/**
 * @file The signature that tells a server event from a forged one. PostHog's
 * project key is public, so anyone can capture an event with any
 * `distinct_id`, `source`, `access` or target; the timelines trust those
 * fields only on a row whose `server_sig` verifies. The signature is
 * HMAC-SHA256 over the fields the timeline trusts, never the timestamp, with
 * a key derived from `SESSION_SECRET`, so rotating that secret makes older
 * events read as unverified.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { getEnv } from '@/configs/env.config'

/**
 * The fields a signature covers; null for an absent one.
 */
export interface SignedEventFields {
  uuid: string
  event: string
  distinctId: string
  source: string | null
  access: string | null
  targetType: string | null
  targetId: string | null
  /**
   * The event's `$groups.tenant`.
   */
  tenant: string | null
}

/**
 * Hex characters kept from the HMAC: 128 bits.
 */
const SIGNATURE_LENGTH = 32

const KEY_INFO = 'analytics-event-signature-v1'
const KEY_BYTES = 32

/**
 * The derived key, computed on first use.
 */
const signing: { key: Buffer | undefined } = { key: undefined }

/**
 * The signing key: HKDF-SHA256 of `SESSION_SECRET`, no salt, info
 * `analytics-event-signature-v1`.
 * @returns The 32-byte key.
 */
function signingKey(): Buffer {
  signing.key ??= Buffer.from(hkdfSync('sha256', getEnv().SESSION_SECRET, '', KEY_INFO, KEY_BYTES))
  return signing.key
}

/**
 * The string a signature is computed over: the eight fields in order,
 * joined by a newline, an absent one as the empty string.
 * The join is unambiguous only because no signed value can contain a newline
 * (each is a constant, an enum value or an id).
 * @param fields - The fields.
 * @returns The canonical string.
 */
function canonical(fields: SignedEventFields): string {
  return [
    fields.uuid,
    fields.event,
    fields.distinctId,
    fields.source ?? '',
    fields.access ?? '',
    fields.targetType ?? '',
    fields.targetId ?? '',
    fields.tenant ?? '',
  ].join('\n')
}

/**
 * Sign a server event.
 * @param fields - The event's signed fields, as they will be sent.
 * @returns The first 32 hex characters of the HMAC-SHA256.
 */
export function signAnalyticsEvent(fields: SignedEventFields): string {
  return createHmac('sha256', signingKey())
    .update(canonical(fields))
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH)
}

/**
 * Whether a signature is this server's for these fields, compared in
 * constant time.
 * @param fields - The fields as PostHog returned them.
 * @param signature - The row's `server_sig`, untrusted.
 * @returns True only for a 32-character string that matches.
 */
export function isAnalyticsSignatureValid(fields: SignedEventFields, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length !== SIGNATURE_LENGTH) return false
  const expected = Buffer.from(signAnalyticsEvent(fields), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Forget the derived key, so the next call derives it again from the
 * current `SESSION_SECRET`. For tests.
 */
export function resetAnalyticsSigningKey(): void {
  signing.key = undefined
}
