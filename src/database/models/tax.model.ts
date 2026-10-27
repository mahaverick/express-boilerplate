/**
 * @file The GST tables: each workspace's tax details, the tax documents
 * issued (invoices and credit notes), their gap-free number counters and the
 * charges held back for a SEZ buyer. A document outlives its tenant, so its
 * `tenant_id` is SET NULL and its snapshot holds every printed field.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  BILLING_PROVIDER_MODES,
  BILLING_PROVIDERS,
  type BillingProvider,
  type BillingProviderMode,
} from '@/constants/billing.constants'
import { TAX_DOCUMENT_TYPES, type TaxDocumentType } from '@/constants/gst.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import type { TaxDocumentSnapshot } from '@/types/tax'
import { sqlValueList } from '@/utilities/sql-value-list.utilities'

/**
 * A provider id (payment, refund or subscription) as Razorpay issues it, with room to spare.
 */
const PROVIDER_ID_LENGTH = 64

/**
 * The `tenant_tax_details` table: the legal name, address, state and GSTIN a
 * workspace's invoices print. The CHECKs hold only the always-true
 * invariants; the conditional address rules are API rules, so a stored row
 * that today's rules refuse still loads.
 */
export const tenantTaxDetailsModel = pgTable(
  'tenant_tax_details',
  {
    tenantId: varchar('tenant_id', { length: 36 })
      .primaryKey()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    gstin: varchar('gstin', { length: 15 }),
    legalName: varchar('legal_name', { length: 100 }).notNull(),
    addressLine1: varchar('address_line1', { length: 100 }),
    addressLine2: varchar('address_line2', { length: 100 }),
    city: varchar('city', { length: 60 }),
    pincode: char('pincode', { length: 6 }),
    /**
     * Required from the first save: it decides CGST + SGST or IGST.
     */
    stateCode: char('state_code', { length: 2 }).notNull(),
    isSez: boolean('is_sez').notNull().default(false),
    updatedBy: varchar('updated_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check(
      'tenant_tax_details_gstin_check',
      sql`${table.gstin} is null or ${table.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`
    ),
    check('tenant_tax_details_sez_check', sql`not ${table.isSez} or ${table.gstin} is not null`),
    check(
      'tenant_tax_details_state_check',
      sql`${table.gstin} is null or ${table.stateCode} = left(${table.gstin}, 2)`
    ),
  ]
)

/**
 * The `tax_documents` table: every invoice and credit note issued. No code
 * updates or deletes a row; the one change is the database's own, nulling
 * `tenant_id` when the tenant is purged (SET NULL), because GST records are
 * kept 72 months after that.
 */
export const taxDocumentModel = pgTable(
  'tax_documents',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    type: varchar('type', { length: 16 }).$type<TaxDocumentType>().notNull(),
    number: varchar('number', { length: 16 }).notNull(),
    financialYear: char('financial_year', { length: 5 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, precision: 3 }).notNull(),
    tenantId: varchar('tenant_id', { length: 36 }).references(() => tenantModel.id, {
      onDelete: 'set null',
    }),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>().notNull(),
    providerMode: varchar('provider_mode', { length: 8 }).$type<BillingProviderMode>().notNull(),
    paymentId: varchar('payment_id', { length: PROVIDER_ID_LENGTH }),
    refundId: varchar('refund_id', { length: PROVIDER_ID_LENGTH }),
    subscriptionId: varchar('subscription_id', { length: PROVIDER_ID_LENGTH }),
    originalDocumentId: varchar('original_document_id', { length: 36 }).references(
      (): AnyPgColumn => taxDocumentModel.id,
      { onDelete: 'restrict' }
    ),
    totalMinor: integer('total_minor').notNull(),
    taxableMinor: integer('taxable_minor').notNull(),
    cgstMinor: integer('cgst_minor').notNull(),
    sgstMinor: integer('sgst_minor').notNull(),
    igstMinor: integer('igst_minor').notNull(),
    supply: varchar('supply', { length: 8 }).$type<'intra' | 'inter'>().notNull(),
    placeOfSupply: char('place_of_supply', { length: 2 }).notNull(),
    buyerGstin: varchar('buyer_gstin', { length: 15 }),
    /**
     * Every printed field, frozen at issue.
     */
    snapshot: jsonb('snapshot').$type<TaxDocumentSnapshot>().notNull(),
    /**
     * A credit note that refunds the amount without reducing the tax.
     */
    noTaxReduction: boolean('no_tax_reduction').notNull().default(false),
    reason: varchar('reason', { length: 500 }),
    createdBy: varchar('created_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'tax_documents_type_check',
      sql`${table.type} in (${sql.raw(sqlValueList(TAX_DOCUMENT_TYPES))})`
    ),
    check(
      'tax_documents_provider_check',
      sql`${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'tax_documents_provider_mode_check',
      sql`${table.providerMode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    check('tax_documents_supply_check', sql`${table.supply} in ('intra', 'inter')`),
    check('tax_documents_total_check', sql`${table.totalMinor} > 0`),
    check(
      'tax_documents_parts_check',
      sql`${table.totalMinor} = ${table.taxableMinor} + ${table.cgstMinor} + ${table.sgstMinor} + ${table.igstMinor}`
    ),
    check(
      'tax_documents_invoice_check',
      sql`${table.type} <> 'invoice' or (${table.paymentId} is not null and ${table.originalDocumentId} is null and ${table.refundId} is null)`
    ),
    check(
      'tax_documents_credit_note_check',
      sql`${table.type} <> 'credit_note' or ${table.originalDocumentId} is not null`
    ),
    unique('tax_documents_number_unique').on(table.type, table.financialYear, table.number),
    uniqueIndex('tax_documents_invoice_payment_unique')
      .on(table.provider, table.providerMode, table.paymentId)
      .where(sql`${table.type} = 'invoice'`),
    uniqueIndex('tax_documents_refund_unique')
      .on(table.provider, table.providerMode, table.refundId)
      .where(sql`${table.refundId} is not null`),
    // Ends in id: the tenant's list sorts by issue date with the id tiebreak, both ways, with no Sort.
    index('tax_documents_tenant_issued_idx').on(table.tenantId, table.issuedAt, table.id),
    index('tax_documents_issued_idx').on(table.issuedAt, table.id),
    index('tax_documents_original_idx').on(table.originalDocumentId),
  ]
)

/**
 * The `tax_document_counters` table: the last number issued per document type
 * and financial year. Locked for one insert and its audit entry only, so
 * numbers have no gaps.
 */
export const taxDocumentCounterModel = pgTable(
  'tax_document_counters',
  {
    type: varchar('type', { length: 16 }).$type<TaxDocumentType>().notNull(),
    financialYear: char('financial_year', { length: 5 }).notNull(),
    lastNumber: integer('last_number').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.type, table.financialYear] }),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'tax_document_counters_type_check',
      sql`${table.type} in (${sql.raw(sqlValueList(TAX_DOCUMENT_TYPES))})`
    ),
  ]
)

/**
 * The `tax_held_charges` table: a charge from a SEZ buyer that was not
 * invoiced and waits for staff to issue it by hand. A staff resolve is the
 * only update; the rows go with their tenant (cascade).
 */
export const taxHeldChargeModel = pgTable(
  'tax_held_charges',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 }).$type<BillingProvider>().notNull(),
    providerMode: varchar('provider_mode', { length: 8 }).$type<BillingProviderMode>().notNull(),
    paymentId: varchar('payment_id', { length: PROVIDER_ID_LENGTH }).notNull(),
    subscriptionId: varchar('subscription_id', { length: PROVIDER_ID_LENGTH }),
    amountMinor: integer('amount_minor').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    heldAt: timestamp('held_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: varchar('resolved_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    resolution: varchar('resolution', { length: 500 }),
  },
  (table) => [
    check(
      'tax_held_charges_provider_check',
      sql`${table.provider} in (${sql.raw(sqlValueList(BILLING_PROVIDERS))})`
    ),
    check(
      'tax_held_charges_provider_mode_check',
      sql`${table.providerMode} in (${sql.raw(sqlValueList(BILLING_PROVIDER_MODES))})`
    ),
    unique('tax_held_charges_payment_unique').on(
      table.provider,
      table.providerMode,
      table.paymentId
    ),
    index('tax_held_charges_tenant_held_idx').on(table.tenantId, table.heldAt, table.id),
  ]
)

/**
 * A tenant_tax_details row as read from the database.
 */
export type TenantTaxDetailsRecord = InferSelectModel<typeof tenantTaxDetailsModel>

/**
 * A new `tenant_tax_details` row.
 */
export type NewTenantTaxDetails = InferInsertModel<typeof tenantTaxDetailsModel>

/**
 * A tax_documents row as read from the database.
 */
export type TaxDocumentRecord = InferSelectModel<typeof taxDocumentModel>

/**
 * A new `tax_documents` row.
 */
export type NewTaxDocument = InferInsertModel<typeof taxDocumentModel>

/**
 * A tax_held_charges row as read from the database.
 */
export type TaxHeldChargeRecord = InferSelectModel<typeof taxHeldChargeModel>

/**
 * A new `tax_held_charges` row.
 */
export type NewTaxHeldCharge = InferInsertModel<typeof taxHeldChargeModel>
