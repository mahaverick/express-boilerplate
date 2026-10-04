/**
 * @file The throttled audit of a staff read view (a timeline, an errors
 * list): one entry per staff member, target and view every
 * `TIMELINE_AUDIT_THROTTLE_SECONDS`, claimed with Redis `SET NX EX`. It
 * fails toward auditing: a Redis failure writes the entry anyway, and a
 * failed write releases the key it claimed, so the next read is audited.
 */
import { TIMELINE_AUDIT_THROTTLE_SECONDS } from '@/constants/timeline.constants'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'
import type { TimelineKind } from '@/types/timeline'

/**
 * One throttled view audit.
 */
export interface ThrottledViewAudit {
  /**
   * The throttle key, built with `redisKey()`; it names the staff member,
   * the target and the view.
   */
  key: string
  /**
   * The view's name as the log lines say it, capitalised: `Timeline`, `Errors view`.
   */
  label: string
  /**
   * Whose view: a user's or a tenant's.
   */
  kind: TimelineKind
  /**
   * The user or tenant id.
   */
  targetId: string
  /**
   * Writes the audit entry; called only when the key was claimed or Redis failed.
   */
  write: () => Promise<void>
}

/**
 * Delete a throttle key after a failed audit write. If the delete fails too,
 * the next reads inside the throttle window find the key and are not audited,
 * so that is logged at `error`, with the target but not the key.
 * @param audit - The audit whose write failed.
 * @returns Resolves once deleted or logged.
 */
async function releaseThrottleKey(audit: ThrottledViewAudit): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.del(audit.key)
  } catch (error) {
    logger.error(
      `Could not release the ${audit.label.toLowerCase()} audit throttle key after a failed audit write; reads of this target may go unaudited until it expires`,
      {
        error,
        kind: audit.kind,
        targetId: audit.targetId,
        unauditedSeconds: TIMELINE_AUDIT_THROTTLE_SECONDS,
      }
    )
  }
}

/**
 * Audit a staff read view at most once per throttle window: the entry is
 * written only when `SET NX EX` claims the key. A Redis failure writes the
 * entry anyway, logged at `warn`; a failed write releases the key it
 * claimed, then rethrows.
 * @param audit - The key, the log label, the target and the writer.
 * @returns Resolves once written, or once the throttle said it already was.
 * @throws {Error} When the audit write fails.
 */
export async function auditThrottledView(audit: ThrottledViewAudit): Promise<void> {
  let hasClaimedKey = false
  try {
    const redis = await getRedis()
    const reply = await redis.set(audit.key, '1', {
      condition: 'NX',
      expiration: { type: 'EX', value: TIMELINE_AUDIT_THROTTLE_SECONDS },
    })
    if (reply === null) return
    hasClaimedKey = true
  } catch (error) {
    logger.warn(`${audit.label} audit throttle unavailable; writing the audit entry anyway`, {
      error,
    })
  }
  try {
    await audit.write()
  } catch (error) {
    if (hasClaimedKey) await releaseThrottleKey(audit)
    throw error
  }
}
