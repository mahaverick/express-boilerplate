/**
 * @file Query access to `email_suppressions`. It does not extend
 * `BaseRepository`: a suppression is lifted, never soft-deleted, and the
 * lifted row stays as history.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { SuppressionReason } from '@/constants/email.constants'
import {
  emailSuppressionModel,
  type EmailSuppression,
} from '@/database/models/email-suppression.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'

/**
 * What adds a suppression: the address, why, and the event that caused it.
 */
export interface NewSuppression {
  address: string
  reason: SuppressionReason
  /**
   * The `email_events` row that caused it, when there is one.
   */
  sourceEventId?: string | null
}

/**
 * Query access to `email_suppressions`: add one, find the active one for an
 * address, lift one.
 */
export class EmailSuppressionRepository {
  /**
   * Suppress an address, lowercased. When it is already actively suppressed
   * nothing is written (the partial unique index on active rows), so a
   * second bounce is a no-op.
   * @param suppression - The address, the reason and the source event.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The new row, or undefined when the address was already suppressed.
   */
  async suppress(
    suppression: NewSuppression,
    executor: DbExecutor = db
  ): Promise<EmailSuppression | undefined> {
    const [inserted] = await executor
      .insert(emailSuppressionModel)
      .values({
        address: suppression.address.toLowerCase(),
        reason: suppression.reason,
        sourceEventId: suppression.sourceEventId,
      })
      .onConflictDoNothing({
        target: emailSuppressionModel.address,
        where: sql`${emailSuppressionModel.liftedAt} is null`,
      })
      .returning()
    return inserted
  }

  /**
   * The active suppression for an address, if there is one.
   * @param address - The address, in any case.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The active row, or undefined.
   */
  async findActive(
    address: string,
    executor: DbExecutor = db
  ): Promise<EmailSuppression | undefined> {
    const normalized = address.toLowerCase()
    const [row] = await executor
      .select()
      .from(emailSuppressionModel)
      .where(
        and(eq(emailSuppressionModel.address, normalized), isNull(emailSuppressionModel.liftedAt))
      )
      .limit(1)
    return row
  }

  /**
   * Lift an active suppression, recording who and why.
   * @param id - The suppression.
   * @param lift - The staff user and their reason.
   * @param lift.liftedBy - The staff user's id.
   * @param lift.liftReason - Their reason.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The lifted row, or undefined when it does not exist or was already lifted.
   */
  async lift(
    id: string,
    lift: { liftedBy: string; liftReason: string },
    executor: DbExecutor = db
  ): Promise<EmailSuppression | undefined> {
    const [row] = await executor
      .update(emailSuppressionModel)
      .set({ liftedAt: sql`now()`, liftedBy: lift.liftedBy, liftReason: lift.liftReason })
      .where(and(eq(emailSuppressionModel.id, id), isNull(emailSuppressionModel.liftedAt)))
      .returning()
    return row
  }

  /**
   * Forget which staff member lifted a suppression, for their user purge.
   * The suppression itself stays: it belongs to the address, and dropping it
   * would let mail reach a mailbox known to bounce or complain.
   * @param userId - The purged user.
   * @param tx - The purge's transaction.
   * @returns How many rows changed.
   */
  async clearLiftedBy(userId: string, tx: DbTransaction): Promise<number> {
    const result = await tx
      .update(emailSuppressionModel)
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: no one is recorded as the lifter
      .set({ liftedBy: null })
      .where(eq(emailSuppressionModel.liftedBy, userId))
    return result.count
  }
}
