/**
 * @file Which From address a message goes out from. The sender follows the
 * template's sender class and nothing else, so no caller picks it. A token
 * email uses `MAIL_FROM_TRANSACTIONAL`, which is `MAIL_FROM` while unset.
 */
import type { Env } from '@/configs/env.config'
import type { SenderClass } from '@/constants/email.constants'

/**
 * The From address for one sender class.
 * @param senderClass - The template's sender class.
 * @param env - The two configured senders.
 * @returns `MAIL_FROM_TRANSACTIONAL` (or `MAIL_FROM` when it is unset) for `transactional`; `MAIL_FROM` for `general`.
 */
export function senderFor(
  senderClass: SenderClass,
  env: Pick<Env, 'MAIL_FROM' | 'MAIL_FROM_TRANSACTIONAL'>
): string {
  if (senderClass === 'general') return env.MAIL_FROM
  return env.MAIL_FROM_TRANSACTIONAL ?? env.MAIL_FROM
}

/**
 * The domain of a sender address, lowercased: what a Message-ID's right-hand
 * side uses, and what two senders are compared on.
 * @param address - A bare address, as the schema validates `MAIL_FROM`.
 * @returns Everything after the last `@`, lowercased.
 */
export function senderDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}
