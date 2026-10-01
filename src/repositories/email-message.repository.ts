/**
 * @file Query access to `email_messages`. It does not extend `BaseRepository`:
 * a message has no `updatedAt`/`deletedAt`, and its one mutable field,
 * `status`, moves only forward, through `advanceStatus` and `markSuppressed`.
 */
import { and, eq, sql } from 'drizzle-orm'
import {
  EMAIL_STATUS_RANK,
  SECRET_VARIABLE_PATTERN,
  type AdvanceableEmailStatus,
  type FailureOrigin,
} from '@/constants/email.constants'
import {
  emailMessageModel,
  type EmailMessage,
  type NewEmailMessage,
} from '@/database/models/email-message.model'
import { HttpError } from '@/errors/http-error'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * What enqueue writes: every identifying column, with the id read first
 * from `nextId`. Status starts at `queued`; the timestamps default.
 */
export type NewQueuedEmailMessage = Omit<
  NewEmailMessage,
  'id' | 'status' | 'failureOrigin' | 'statusUpdatedAt' | 'createdAt'
> & { id: string }

/**
 * `EMAIL_STATUS_RANK` as the `when … then …` arms of a SQL `CASE` on the
 * status column, built once, outside the query's template so
 * `sonarjs/no-nested-template-literals` holds.
 */
const STATUS_RANK_CASE_ARMS = Object.entries(EMAIL_STATUS_RANK)
  .map(([status, rank]) => `when '${status}' then ${String(rank)}`)
  .join(' ')

/**
 * The first variable name that looks like it carries a secret.
 * @param variables - The variables about to be stored.
 * @returns The offending key, or undefined when there is none.
 */
function secretVariableName(variables: Record<string, string>): string | undefined {
  return Object.keys(variables).find((key) => SECRET_VARIABLE_PATTERN.test(key))
}

/**
 * Query access to `email_messages`: allocate an id, create a queued row,
 * move its status forward, and look it up.
 */
export class EmailMessageRepository {
  /**
   * A fresh uuidv7 from Postgres, so the caller can build the Message-ID
   * header before the row exists. The app has no v7 generator of its own.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The new id.
   */
  async nextId(executor: DbExecutor = db): Promise<string> {
    const rows = await executor.execute<{ id: string }>(sql`select uuidv7()::text as id`)
    const [row] = rows
    if (row === undefined) throw new HttpError('uuidv7() returned no row', 500)
    return row.id
  }

  /**
   * Insert a message in `queued`. A row whose `jobKey` another row already
   * holds inserts nothing and returns that existing row, so a retried
   * enqueue with the same BullMQ job id never leaves an orphan. When the
   * existing row failed at enqueue (the job never reached the queue), it
   * goes back to `queued`, since this call is the retry of that enqueue. A
   * row with no `jobKey` never conflicts: NULLs are distinct.
   * @param row - The message to insert.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, or the existing one holding `row.jobKey`.
   * @throws {Error} When `row.variables` has a key ending in `Url` or `Token`, before any query runs.
   */
  async createQueued(row: NewQueuedEmailMessage, executor: DbExecutor = db): Promise<EmailMessage> {
    const secretName = secretVariableName(row.variables ?? {})
    if (secretName !== undefined) {
      throw new Error(`Refusing to store email variable "${secretName}": it names a secret.`)
    }
    const enqueueFailed = sql`${emailMessageModel.status} = 'failed' and ${emailMessageModel.failureOrigin} = 'enqueue'`
    const [inserted] = await executor
      .insert(emailMessageModel)
      .values({ ...row, status: 'queued' })
      .onConflictDoUpdate({
        target: emailMessageModel.jobKey,
        set: {
          jobKey: sql`excluded.job_key`,
          status: sql`case when ${enqueueFailed} then 'queued' else ${emailMessageModel.status} end`,
          failureOrigin: sql`case when ${enqueueFailed} then null else ${emailMessageModel.failureOrigin} end`,
          statusUpdatedAt: sql`case when ${enqueueFailed} then now() else ${emailMessageModel.statusUpdatedAt} end`,
        },
      })
      .returning()
    if (inserted === undefined) throw new HttpError('Insert returned no row', 500)
    return inserted
  }

  /**
   * Move a message to `status` when that ranks strictly higher than its
   * current one (`EMAIL_STATUS_RANK`), in one conditional UPDATE, so two
   * writers racing each other can only ever move it forward. A suppressed
   * message never left this server, so nothing advances it.
   * @param id - The message.
   * @param status - The status to move to.
   * @param options - `failureOrigin`, written with a `failed` status.
   * @param options.failureOrigin - Who set `failed`.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Whether the row changed.
   */
  async advanceStatus(
    id: string,
    status: AdvanceableEmailStatus,
    options: { failureOrigin?: FailureOrigin } = {},
    executor: DbExecutor = db
  ): Promise<boolean> {
    const rows = await executor
      .update(emailMessageModel)
      .set({
        status,
        statusUpdatedAt: sql`now()`,
        ...(options.failureOrigin !== undefined && { failureOrigin: options.failureOrigin }),
      })
      .where(
        and(
          eq(emailMessageModel.id, id),
          sql`${emailMessageModel.status} <> 'suppressed'`,
          sql`(case ${emailMessageModel.status} ${sql.raw(STATUS_RANK_CASE_ARMS)} end) < ${EMAIL_STATUS_RANK[status]}`
        )
      )
      .returning({ id: emailMessageModel.id })
    return rows.length > 0
  }

  /**
   * Mark a message `suppressed`: its recipient is on the suppression list,
   * so it is never sent. Only from `queued`.
   * @param id - The message.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns Whether the row changed.
   */
  async markSuppressed(id: string, executor: DbExecutor = db): Promise<boolean> {
    const rows = await executor
      .update(emailMessageModel)
      .set({ status: 'suppressed', statusUpdatedAt: sql`now()` })
      .where(and(eq(emailMessageModel.id, id), eq(emailMessageModel.status, 'queued')))
      .returning({ id: emailMessageModel.id })
    return rows.length > 0
  }

  /**
   * One message by id.
   * @param id - The message.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined.
   */
  async findById(id: string, executor: DbExecutor = db): Promise<EmailMessage | undefined> {
    const [row] = await executor
      .select()
      .from(emailMessageModel)
      .where(eq(emailMessageModel.id, id))
      .limit(1)
    return row
  }

  /**
   * One message by the Message-ID header it was sent with, as a provider
   * event reports it.
   * @param header - The header, angle brackets included.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined.
   */
  async findByMessageIdHeader(
    header: string,
    executor: DbExecutor = db
  ): Promise<EmailMessage | undefined> {
    const [row] = await executor
      .select()
      .from(emailMessageModel)
      .where(eq(emailMessageModel.messageIdHeader, header))
      .limit(1)
    return row
  }
}
