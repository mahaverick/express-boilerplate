// src/repositories/base.repository.ts
//
// Generic over the Drizzle table's *config* type, not over query-builder
// mechanics — a deliberate, narrower shape than "just parameterize
// db.select().from()". `PgSelectBuilder.from()` (drizzle-orm 0.45.2) types
// its parameter as a DEFERRED conditional —
// `TableLikeHasEmptySelection<TFrom> extends true ? DrizzleTypeError<...>
// : TFrom` — and TypeScript cannot assign an unresolved generic type
// parameter to a conditional type it cannot yet reduce. This is not
// specific to this file's design: the minimal possible repro,
// `function f<T extends PgTable>(t: T) { return db.select().from(t) }`,
// fails with the identical TS2345 in this drizzle-orm version. The same
// deferred-conditional problem breaks a generic `.update(table).set(...)`
// and `.returning()`'s result type for the same reason.
//
// So this class does NOT call `db.select()/.insert()/.update()` itself.
// It owns policy — which condition to query with (soft-delete visibility),
// what to write on every mutation (`updatedAt`), and how to translate a
// unique-violation — and delegates the four actual Drizzle chains to
// `protected abstract` primitives that a subclass implements against its
// own CONCRETE table (e.g. `userModel`, a literal type, not a generic type
// parameter — where every one of the conditional types above resolves
// normally). That subclass is still constrained to return this class's
// `InferSelectModel`/`InferInsertModel` types, so it cannot silently drift
// from the shape this class computes from the table config — the split is
// between *which query to run* (subclass) and *whether the row qualifies /
// what non-column-specific writes every mutation gets* (base).
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
   * false — the entire point of soft delete is that a deleted row behaves
   * like it does not exist unless a caller explicitly asks otherwise.
   */
  includeDeleted?: boolean
}

/**
 * A write payload with `updatedAt` attached. Every mutation goes through
 * `BaseRepository.touched`, so a subclass's `updateOne`/`markDeleted`
 * signature can require exactly this — not a hand-rolled shape that could
 * quietly omit the timestamp bump on one code path.
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
 * - Translating a Postgres unique-violation (23505) into `HttpError(409)`.
 *   A repository method that skipped this would let a duplicate-email
 *   insert reach the client as a raw driver error — a 500 instead of the
 *   409 a controller needs to say "that address is taken".
 *
 * A subclass supplies the four concrete Drizzle chains (`selectOne`,
 * `insertOne`, `updateOne`, `markDeleted`) against its own table; see this
 * file's header comment for why that split exists.
 */
export abstract class BaseRepository<TConfig extends SoftDeletableTableConfig> {
  /**
   * @param table - The Drizzle table this repository queries. Held only for column references (`.id`, `.deletedAt`) used to build conditions — never passed to a Drizzle query-builder method generically; see this file's header comment.
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
   * Combine a match condition with soft-delete visibility. Every lookup —
   * `findById` here, or a subclass's own (e.g. `findByEmail`) — should build
   * its condition through this method rather than appending
   * `isNull(deletedAt)` by hand at each call site: a lookup that forgot
   * would let a soft-deleted row keep matching, which for a user record
   * means a "deleted" account that can still log in. Takes the same
   * `SoftDeleteOptions` object every public method already receives, rather
   * than a bare boolean, so a call site reads `scope(condition, options)`
   * instead of an unlabelled `true`/`false`.
   * @param condition - The match condition, e.g. a primary key or unique-column comparison.
   * @param options - Soft-delete visibility options.
   * @returns The combined condition, ready for a subclass's `.where()`.
   */
  protected scope(condition: SQL, options: SoftDeleteOptions = {}): SQL | undefined {
    return options.includeDeleted ? condition : and(condition, isNull(this.table.deletedAt))
  }

  /**
   * Attach a database-side `updatedAt = now()` to a write payload. `now()`
   * is evaluated by Postgres, not read from the application's clock, so a
   * bump can never disagree with the server that actually timestamps the
   * row.
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
   * @returns The matching row, or undefined when none exists — including when it exists but is soft-deleted and `includeDeleted` was not set.
   */
  findById(
    id: string,
    options: SoftDeleteOptions = {}
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.selectOne(this.scope(eq(this.table.id, id), options))
  }

  /**
   * Insert a new row.
   * @param values - The row's initial column values.
   * @returns The inserted row, including database-generated defaults (e.g. `id`, `createdAt`).
   */
  create(
    values: InferInsertModel<PgTableWithColumns<TConfig>>
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>>> {
    return this.translatingUniqueViolation(() => this.insertOne(values))
  }

  /**
   * Update a row's columns and bump `updatedAt`.
   * @param id - The row's id.
   * @param values - The columns to change. `id`, `createdAt` and `updatedAt` are excluded even if passed — none is meant to change by hand.
   * @param options - Soft-delete visibility options.
   * @returns The updated row, or undefined when no matching row exists.
   */
  update(
    id: string,
    values: Partial<
      Omit<InferInsertModel<PgTableWithColumns<TConfig>>, 'id' | 'createdAt' | 'updatedAt'>
    >,
    options: SoftDeleteOptions = {}
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.translatingUniqueViolation(() =>
      this.updateOne(this.scope(eq(this.table.id, id), options), this.touched(values))
    )
  }

  /**
   * Soft-delete a row: sets `deletedAt` (and bumps `updatedAt`) rather than
   * removing it. A no-op — returns undefined rather than throwing — when
   * the row does not exist or is already soft-deleted, so callers do not
   * need to check existence first.
   * @param id - The row's id.
   * @returns The updated row, or undefined when no matching, not-yet-deleted row exists.
   */
  softDelete(id: string): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined> {
    return this.markDeleted(this.scope(eq(this.table.id, id)))
  }

  /**
   * Select the single row matching a condition. Implemented by a subclass
   * against its own concrete table.
   * @param where - The condition to match, or undefined to match every row.
   * @returns The matching row, or undefined when none exists.
   */
  protected abstract selectOne(
    where: SQL | undefined
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>

  /**
   * Insert a single row. Implemented by a subclass against its own concrete
   * table.
   * @param values - The row's initial column values.
   * @returns The inserted row.
   */
  protected abstract insertOne(
    values: InferInsertModel<PgTableWithColumns<TConfig>>
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>>>

  /**
   * Update the single row matching a condition. Implemented by a subclass
   * against its own concrete table.
   * @param where - The condition to match, already scoped for soft-delete visibility.
   * @param values - The columns to change, already carrying `updatedAt`.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected abstract updateOne(
    where: SQL | undefined,
    values: Touched<
      Partial<Omit<InferInsertModel<PgTableWithColumns<TConfig>>, 'id' | 'createdAt' | 'updatedAt'>>
    >
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>

  /**
   * Set `deletedAt` on the single row matching a condition. Implemented by a
   * subclass against its own concrete table.
   * @param where - The condition to match, already scoped to not-yet-deleted rows.
   * @returns The updated row, or undefined when no matching row exists.
   */
  protected abstract markDeleted(
    where: SQL | undefined
  ): Promise<InferSelectModel<PgTableWithColumns<TConfig>> | undefined>
}
