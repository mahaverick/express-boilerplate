/**
 * @file The flags a snapshot holds that the registry lacks, as the Apex lists
 * and the system status count them. A key longer than `LISTED_FLAG_KEY_MAX`
 * cannot round-trip through a list cursor, so it is left out of both and still
 * evaluates; one warning per snapshot names it.
 */
import { findFlagEntry, LISTED_FLAG_KEY_MAX } from '@/constants/flags.constants'
import { logger } from '@/services/logger.service'
import type { ParsedDefinition, ParsedSnapshot } from '@/validators/flag-definition.validators'

/**
 * The snapshots already warned about, so a snapshot is warned about once.
 */
const warnedSnapshots = new WeakSet<ParsedSnapshot>()

/**
 * The unregistered flags of a snapshot whose keys fit a list cursor.
 * @param snapshot - This replica's snapshot, or null.
 * @returns The definitions; empty without a snapshot.
 */
export function listableUnregisteredFlags(snapshot: ParsedSnapshot | null): ParsedDefinition[] {
  if (snapshot === null) return []
  const unregistered = Object.values(snapshot.flags).filter((flag) => !findFlagEntry(flag.key))
  const tooLong = unregistered.filter((flag) => flag.key.length > LISTED_FLAG_KEY_MAX)
  if (tooLong.length > 0 && !warnedSnapshots.has(snapshot)) {
    warnedSnapshots.add(snapshot)
    for (const flag of tooLong) {
      logger.warn('Flag key too long to list; leaving it out of the flags lists', {
        keyLength: flag.key.length,
        keyPrefix: flag.key.slice(0, 40),
      })
    }
  }
  return unregistered.filter((flag) => flag.key.length <= LISTED_FLAG_KEY_MAX)
}
