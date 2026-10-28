/**
 * @file Staff-only reads and writes of tax records across workspaces: one
 * workspace's document and held-charge lists, the open held count, whether
 * any document exists on the platform (purged workspaces' included), the
 * held-charge resolve, and the documents issued in a period for the export.
 * Only `services/platform-*.service.ts` may import this file (an eslint
 * rule).
 */
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { TaxDocumentType } from '@/constants/gst.constants'
import {
  taxDocumentModel,
  taxHeldChargeModel,
  type TaxDocumentRecord,
  type TaxHeldChargeRecord,
} from '@/database/models/tax.model'
import { userModel } from '@/database/models/user.model'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import {
  defineList,
  searchCondition,
  timestampKey,
  timestampSort,
} from '@/utilities/list-page.utilities'

/**
 * One document on the staff list, with the name of the staff member who
 * issued it by hand (null for an automatic note, or a purged account).
 */
export interface StaffTaxDocumentRow {
  document: TaxDocumentRecord
  createdBy: { userId: string; name: string } | null
}

/**
 * The staff document list's filters.
 */
export interface StaffTaxDocumentFilters {
  types: TaxDocumentType[] | undefined
}

/**
 * Whether a held charge is waiting or resolved.
 */
export type HeldChargeStatus = 'open' | 'resolved'

/**
 * One held charge with the name of whoever resolved it.
 */
export interface HeldChargeRow {
  charge: TaxHeldChargeRecord
  resolvedBy: { userId: string; name: string } | null
}

/**
 * A document in the export, a credit note carrying its invoice's buyer
 * GSTIN, number and issue date.
 */
export type ExportDocument = TaxDocumentRecord & {
  original: { number: string; issuedAt: Date; buyerGstin: string | null } | null
}

/**
 * A user's display name from their joined columns.
 * @param user - The joined user columns.
 * @param user.id - The user id, or null when the row is gone.
 * @param user.firstName - The first name.
 * @param user.lastName - The last name.
 * @param user.email - The email, the fallback.
 * @returns The person, or null for a purged account.
 */
function personOf(user: {
  id: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
}): { userId: string; name: string } | null {
  if (user.id === null) return null
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
  return { userId: user.id, name: full === '' ? (user.email ?? '') : full }
}

/**
 * One workspace's tax documents, newest first by default; `search` is a
 * literal, case-insensitive part of the number. Its cursors are bound to the
 * workspace.
 * @param tenantId - The workspace.
 * @param search - The parsed search, or undefined.
 * @param filters - The document types.
 * @returns The list definition.
 */
export function staffTaxDocumentList(
  tenantId: string,
  search: string | undefined,
  filters: StaffTaxDocumentFilters
) {
  const document = taxDocumentModel
  return defineList({
    name: 'platform-tenant-tax-documents',
    base: (executor, seek) =>
      executor
        .select({
          id: document.id,
          document,
          userId: userModel.id,
          firstName: userModel.firstName,
          lastName: userModel.lastName,
          email: userModel.email,
          sortAt: timestampKey(document.issuedAt),
        })
        .from(document)
        .leftJoin(userModel, eq(userModel.id, document.createdBy))
        .where(
          and(
            eq(document.tenantId, tenantId),
            filters.types === undefined ? undefined : inArray(document.type, filters.types),
            searchCondition(search, [sql`lower(${document.number})`]),
            seek
          )
        )
        .$dynamic(),
    id: document.id,
    sorts: {
      '-issued': [timestampSort(document.issuedAt, 'desc', 'sortAt')],
      issued: [timestampSort(document.issuedAt, 'asc', 'sortAt')],
    },
    bound: { tenantId },
    toItem: (row): StaffTaxDocumentRow => ({
      document: row.document,
      createdBy: personOf({
        id: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      }),
    }),
  })
}

/**
 * The condition that keeps the wanted held-charge statuses.
 * @param isOpenWanted - Whether open charges are wanted.
 * @param isResolvedWanted - Whether resolved charges are wanted.
 * @returns The condition over `tax_held_charges`, or undefined when both or neither are wanted.
 */
function statusCondition(isOpenWanted: boolean, isResolvedWanted: boolean): SQL | undefined {
  if (isOpenWanted === isResolvedWanted) return undefined
  const held = taxHeldChargeModel
  return isOpenWanted ? isNull(held.resolvedAt) : isNotNull(held.resolvedAt)
}

/**
 * One workspace's held charges, newest held first; the only sort is
 * `-heldAt`. Its cursors are bound to the workspace.
 * @param tenantId - The workspace.
 * @param statuses - The statuses to keep. Undefined or empty keeps both.
 * @returns The list definition.
 */
export function heldChargeList(tenantId: string, statuses: HeldChargeStatus[] | undefined) {
  const held = taxHeldChargeModel
  const wantsOpen = statuses?.includes('open') ?? true
  const wantsResolved = statuses?.includes('resolved') ?? true
  return defineList({
    name: 'platform-tenant-tax-held-charges',
    base: (executor, seek) =>
      executor
        .select({
          id: held.id,
          charge: held,
          userId: userModel.id,
          firstName: userModel.firstName,
          lastName: userModel.lastName,
          email: userModel.email,
          sortAt: timestampKey(held.heldAt),
        })
        .from(held)
        .leftJoin(userModel, eq(userModel.id, held.resolvedBy))
        .where(and(eq(held.tenantId, tenantId), statusCondition(wantsOpen, wantsResolved), seek))
        .$dynamic(),
    id: held.id,
    sorts: { '-heldAt': [timestampSort(held.heldAt, 'desc', 'sortAt')] },
    bound: { tenantId },
    toItem: (row): HeldChargeRow => ({
      charge: row.charge,
      resolvedBy: personOf({
        id: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      }),
    }),
  })
}

/**
 * Staff reads and writes of tax records across workspaces.
 */
export class PlatformTaxRepository {
  /**
   * Count a workspace's unresolved held charges.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The count.
   */
  async countOpenHeld(tenantId: string, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
      .select({ total: count() })
      .from(taxHeldChargeModel)
      .where(and(eq(taxHeldChargeModel.tenantId, tenantId), isNull(taxHeldChargeModel.resolvedAt)))
    return row?.total ?? 0
  }

  /**
   * Whether a workspace has any held charge, open or resolved. It keeps the
   * held-charge routes answering while registration is off, and gives the
   * staff billing view its `hasHeldCharges`.
   * @param tenantId - The workspace.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when at least one exists.
   */
  async hasHeld(tenantId: string, executor: DbExecutor = db): Promise<boolean> {
    const [row] = await executor
      .select({ id: taxHeldChargeModel.id })
      .from(taxHeldChargeModel)
      .where(eq(taxHeldChargeModel.tenantId, tenantId))
      .limit(1)
    return row !== undefined
  }

  /**
   * Whether any tax document exists on the platform, purged workspaces' too.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when at least one exists.
   */
  async hasAnyDocuments(executor: DbExecutor = db): Promise<boolean> {
    const rows = await executor.execute<{ found: boolean }>(
      sql`select exists (select 1 from ${taxDocumentModel}) as found`
    )
    return rows[0]?.found ?? false
  }

  /**
   * Find one of a workspace's held charges.
   * @param tenantId - The workspace.
   * @param id - The held charge id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row with who resolved it, or undefined when unknown or another workspace's.
   */
  async findHeld(
    tenantId: string,
    id: string,
    executor: DbExecutor = db
  ): Promise<HeldChargeRow | undefined> {
    const held = taxHeldChargeModel
    const [row] = await executor
      .select({
        charge: held,
        userId: userModel.id,
        firstName: userModel.firstName,
        lastName: userModel.lastName,
        email: userModel.email,
      })
      .from(held)
      .leftJoin(userModel, eq(userModel.id, held.resolvedBy))
      .where(and(eq(held.id, id), eq(held.tenantId, tenantId)))
    if (row === undefined) return undefined
    return {
      charge: row.charge,
      resolvedBy: personOf({
        id: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      }),
    }
  }

  /**
   * Mark a held charge resolved, only if it is still open.
   * @param tenantId - The workspace.
   * @param id - The held charge id.
   * @param by - The staff member's user id.
   * @param resolution - The staff member's note.
   * @param tx - The open transaction.
   * @returns The updated row, or undefined when unknown, another workspace's or already resolved.
   */
  async resolveHeld(
    tenantId: string,
    id: string,
    by: string,
    resolution: string,
    tx: DbTransaction
  ): Promise<TaxHeldChargeRecord | undefined> {
    const [row] = await tx
      .update(taxHeldChargeModel)
      .set({ resolvedAt: sql`now()`, resolvedBy: by, resolution })
      .where(
        and(
          eq(taxHeldChargeModel.id, id),
          eq(taxHeldChargeModel.tenantId, tenantId),
          isNull(taxHeldChargeModel.resolvedAt)
        )
      )
      .returning()
    return row
  }

  /**
   * The documents issued in `[from, to)`, for the export, ordered by type,
   * issue time and id. A credit note carries its invoice's buyer GSTIN,
   * number and issue date.
   * @param from - The first instant in the period.
   * @param to - The first instant after the period.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The documents.
   */
  async listDocumentsIssuedBetween(
    from: Date,
    to: Date,
    executor: DbExecutor = db
  ): Promise<ExportDocument[]> {
    const document = taxDocumentModel
    const original = alias(taxDocumentModel, 'original')
    const rows = await executor
      .select({
        document,
        originalNumber: original.number,
        originalIssuedAt: original.issuedAt,
        originalBuyerGstin: original.buyerGstin,
      })
      .from(document)
      .leftJoin(original, eq(original.id, document.originalDocumentId))
      .where(and(gte(document.issuedAt, from), lt(document.issuedAt, to)))
      .orderBy(asc(document.type), asc(document.issuedAt), asc(document.id))
    return rows.map((row) => ({
      ...row.document,
      original:
        row.originalNumber === null || row.originalIssuedAt === null
          ? null
          : {
              number: row.originalNumber,
              issuedAt: row.originalIssuedAt,
              buyerGstin: row.originalBuyerGstin,
            },
    }))
  }
}
