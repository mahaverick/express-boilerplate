/**
 * @file `BaseRepository`: soft-delete visibility, `updatedAt` maintenance and
 * unique-violation translation, shared by every repository whose table has
 * `id`, `deletedAt` and `updatedAt`.
 */
import {
  and,
  eq,
  isNull,
  sql,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm'
import type { PgColumn, PgTableWithColumns, TableConfig } from 'drizzle-orm/pg-core'
import { HttpError } from '@/errors/http-error'
import { isUniqueViolation } from '@/errors/postgres-errors'
import { db, type DbExecutor } from '@/services/database.service'

/**
 * The minimum column shape a table must have for `BaseRepository` to manage
 * it: a primary key plus the two timestamps its soft-delete and
 * update-tracking behaviour reads and writes. A concrete table's config
 * satisfies this by having those columns among (usually many) others.
 */
export type SoftDeletableTableConfig = TableConfig & {
  columns: {
    id: PgColumn
    deletedAt: PgColumn
    updatedAt: PgColumn
  }
}

/**
 * Controls whether a lookup or write also considers soft-deleted rows.
 */
export interface SoftDeleteOptions {
  /**
   * When true, a row with `deletedAt` set is still visible. Defaults to
   * false, so a deleted row behaves as if it did not exist.
   */
  includeDeleted?: boolean
}

/**
 * A write payload with `updatedAt` attached by `BaseRepository.touched`, so a
 * subclass's `updateOne` cannot be handed a payload that skips the bump.
 */
export type Touched<TValues> = TValues & { updatedAt: SQL }

/**
 * Query behaviour every repository shares, so it is implemented exactly
 * once rather than once per table:
 *
 * - Soft-delete filtering: a row with `deletedAt` set is excluded from
 *   `findById` — and from any lookup a subclass builds through `scope`
 *   (see `UserRepository.findByEmail`) — unless explicitly requested.
 * - `updatedAt` maintenance: every `update` and `softDelete` bumps it,
 *   via `touched`, so no call site can forget.
 * - Translating a Postgres unique-violation (23505) from `create` and
 *   `update` into `HttpError(409)`, instead of a raw driver error and a 500.
 *
 * A subclass supplies the four concrete Drizzle chains (`selectOne`,
 * `insertOne`, `updateOne`, `markDeleted`) against its own concrete table.
 * This class cannot run them generically: in drizzle-orm 0.45.2
 * `PgSelectBuilder.from()` types its parameter as a deferred conditional, so
 * `function f<T extends PgTable>(t: T) { return db.select().from(t) }` fails
 * with TS2345, and `.update(table).set()` and `.returning()` break the same
 * way. The subclass still returns this class's inferred row types.
 */
export abstract class BaseRepository<TConfig extends SoftDeletableTableConfig> {
  /**
   * @param table - The Drizzle table this repository queries. Held only for column references (`.id`, `.deletedAt`) used to build conditions, never passed to a query builder.
   */
  protected constructor(protected readonly table: PgTableWithColumns<TConfig>) {}

  /**
   * Run a write and translate a Postgres unique-violation (23505) it throws
   * into `HttpError(409)`; any other error propagates unchanged.
   * @param write - The write to run.
   * @returns Whatever `write` resolves to.
   */
  private async translatingUniqueViolation<TResult>(
    write: () => Promise<TResult>
  ): Promise<TResult> {
    try {
      return await write()
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('A record with this value already exists', 409)
      }
      throw error
    }
  }

  /**
   * Combine a match condition with soft-delete visibility. Every lookup
   * builds its condition through this rather than appending
   * `isNull(deletedAt)` by hand: a lookup that forgot would let a
   * soft-deleted user keep matching, and so keep logging in.
   * @param condition - The match condition, e.g. a primary key or unique-column comparison.
   * @param options - Soft-delete visibility options.
   * @returns The combined condition, ready for a subclass's `.where()`.
   */
  protected scope(condition: SQL, options: SoftDeleteOptions = {}): SQL | undefined {
    return options.includeDeleted ? condition : and(condition, isNull(this.table.deletedAt))
  }

  /**
   * Attach a database-side `updatedAt = now()` to a write payload, evaluated
   * by Postgres rather than the application's clock.
   * @param values - The columns a write is changing.
   * @returns The same values with `updatedAt` attached.
   */
  protected touched<TValues extends object>(values: TValues): Touched<TValues> {
    return { ...values, updatedAt: sql`now()` }
  }

  /**
   * Find a row by its primary key.
   * @param id - The row's id.
   * @param options - Soft-delete visibility options.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findById(
    id: string,
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.selectOne(this.scope(eq(this.table.id, id), options), executor)
  }

  /**
   * Insert a new row.
   * @param values - The row's initial column values.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The inserted row, including database-generated defaults (e.g. `id`, `createdAt`).
   */
  create(
    values: InferInsertModel<PgTableWithColumns<TConfig>>,
    executor: DbExecutor = db
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>>> {
    return this.translatingUniqueViolation(() => this.insertOne(values, executor))
  }

  /**
   * Update a row's columns and bump `updatedAt`.
   * @param id - The row's id.
   * @param values - The columns to change. `id`, `createdAt` and `updatedAt` are excluded even if passed — none is meant to change by hand.
   * @param options - Soft-delete visibility options.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no matching row exists.
   */
  update(
    id: string,
    values: Partial<
      Omit<InferInsertModel<PgTableWithColumns<TConfig>>, 'id' | 'createdAt' | 'updatedAt'>
    >,
    options: SoftDeleteOptions = {},
    executor: DbExecutor = db
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.translatingUniqueViolation(() =>
      this.updateOne(this.scope(eq(this.table.id, id), options), this.touched(values), executor)
    )
  }

  /**
   * Soft-delete a row: sets `deletedAt` (and bumps `updatedAt`) rather than
   * removing it. A no-op — returns undefined rather than throwing — when
   * the row does not exist or is already soft-deleted, so callers do not
   * need to check existence first.
   * @param id - The row's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no matching, not-yet-deleted row exists.
   */
  softDelete(
    id: string,
    executor: DbExecutor = db
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.markDeleted(this.scope(eq(this.table.id, id)), executor)
  }

  /**
   * Select the single row matching a condition. Implemented by a subclass
   * against its own concrete table.
   * @param where - The condition to match, or undefined to match every row.
   * @param executor - Where to run the query.
   * @returns The matching row, or undefined when none exists.
   */
  protected abstract selectOne(
    where: SQL | undefined,
    executor?: DbExecutor
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>

  /**
   * Insert a single row. Implemented by a subclass against its own concrete
   * table.
   * @param values - The row's initial column values.
   * @param executor - Where to run the query.
   * @returns The inserted row.
   */
  protected abstract insertOne(
    values: InferInsertModel<PgTableWithColumns<TConfig>>,
    executor?: DbExecutor
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>>>

  /**
   * Update the single row matching a condition. Implemented by a subclass
   * against its own concrete table.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @param executor - Where to run the query.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected abstract updateOne(
    where: SQL | undefined,
    values: Touched<
      Partial<Omit<InferInsertModel<PgTableWithColumns<TConfig>>, 'id' | 'createdAt' | 'updatedAt'>>
    >,
    executor?: DbExecutor
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>

  /**
   * Set `deletedAt` on the single row matching a condition. Implemented by a
   * subclass against its own concrete table.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @param executor - Where to run the query.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected abstract markDeleted(
    where: SQL | undefined,
    executor?: DbExecutor
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>
}
