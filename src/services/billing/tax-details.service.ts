/**
 * @file A workspace's tax details: the gates when GST registration is off,
 * the read, and the save shared by the owner route and the staff route. A
 * save is a PATCH of the changed fields under a version check, in one
 * transaction that re-reads the actor's role under lock, locks the details
 * row, applies the cross-field rules to the merged row, writes only
 * the columns that changed and records the audit entry.
 */
import { gstSellerConfig } from '@/configs/billing.config'
import {
  TAX_DETAILS_NO_CHANGE_MESSAGE,
  TAX_DETAILS_OWNER_ONLY_MESSAGE,
  TAX_DETAILS_VERSION_CONFLICT_CODE,
  TAX_DETAILS_VERSION_CONFLICT_MESSAGE,
  TAX_LEGAL_NAME_REQUIRED_MESSAGE,
  TAX_STATE_REQUIRED_MESSAGE,
} from '@/constants/billing.constants'
import { TAX_DETAIL_FIELDS, type TaxDetailField } from '@/constants/gst.constants'
import type { TenantTaxDetailsRecord } from '@/database/models/tax.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { presentTaxDetails, type TaxDetailsView } from '@/presenters/tax.presenter'
import { TaxRepository } from '@/repositories/tax.repository'
import { record } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import { VALIDATION_FAILED_MESSAGE } from '@/validators/parse.validators'
import {
  taxDetailsRuleIssues,
  type TaxDetailsPatch,
  type TaxDetailsRuleIssue,
  type TaxDetailsValues,
} from '@/validators/tax.validators'

const taxRepository = new TaxRepository()

/**
 * Who is saving and how they reached the workspace: an owner by membership,
 * or staff through the platform with their stated reason.
 */
interface SaveTaxDetailsOptions {
  access: 'member' | 'platform'
  /**
   * The staff member's reason; null for an owner.
   */
  reason: string | null
}

/**
 * The values a first save merges onto: every nullable field empty, no SEZ.
 * The legal name and the state have no default, so a first save must send
 * them.
 */
const EMPTY_DETAILS: Omit<TaxDetailsValues, 'legalName' | 'stateCode'> = {
  gstin: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  pincode: null,
  isSez: false,
}

/**
 * Whether GST registration is on.
 * @returns True when the seller config is complete.
 */
function isRegistered(): boolean {
  return gstSellerConfig() !== null
}

/**
 * Refuse a tax read while registration is off and the workspace has no
 * documents; its issued documents stay readable after registration ends.
 * @param tenantId - The workspace.
 * @throws {HttpError} 404 `tax_documents_disabled` with the read message.
 */
export async function assertTaxReadable(tenantId: string): Promise<void> {
  if (isRegistered() || (await taxRepository.hasDocuments(tenantId))) return
  throw notFoundError('taxDocumentsDisabled', 'read')
}

/**
 * Refuse a tax write while registration is off.
 * @throws {HttpError} 404 `tax_documents_disabled` with the write message.
 */
export function assertTaxWritable(): void {
  if (!isRegistered()) throw notFoundError('taxDocumentsDisabled', 'write')
}

/**
 * A workspace's tax details.
 * @param tenantId - The workspace.
 * @returns The details, or null when never saved.
 */
export async function getTaxDetails(tenantId: string): Promise<TaxDetailsView | null> {
  const row = await taxRepository.findDetails(tenantId)
  return row === undefined ? null : presentTaxDetails(row)
}

/**
 * A stored row's values under their PATCH names.
 * @param row - The row.
 * @returns The values.
 */
function valuesOf(row: TenantTaxDetailsRecord): TaxDetailsValues {
  return {
    gstin: row.gstin,
    legalName: row.legalName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    pincode: row.pincode,
    stateCode: row.stateCode,
    isSez: row.isSez,
  }
}

/**
 * The 400 in the house validation envelope for issues found after parsing.
 * @param issues - Each issue on its field.
 * @returns The error.
 */
function validationError(issues: readonly TaxDetailsRuleIssue[]): HttpError {
  const errors: Record<string, string[]> = {}
  for (const { field, message } of issues) (errors[field] ??= []).push(message)
  return new HttpError(VALIDATION_FAILED_MESSAGE, 400, undefined, errors)
}

/**
 * Re-read the owner's access under lock and refuse anyone but an owner by
 * membership, with the refusal the route's gate gives: a role lowered after
 * the gate still refuses the write.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @param tx - The transaction to hold the locks in.
 * @throws {HttpError} 404 when the actor lost access; 403 below owner or through platform access.
 */
async function lockMemberOwner(actor: Actor, tenantId: string, tx: DbTransaction): Promise<void> {
  const { role, access } = await lockActorRole(actor, tenantId, 'owner', tx).catch(
    (error: unknown) => {
      if (error instanceof HttpError && error.statusCode === 403) {
        throw new HttpError(TAX_DETAILS_OWNER_ONLY_MESSAGE, 403)
      }
      throw error
    }
  )
  if (access !== 'member' || role !== 'owner') {
    throw new HttpError(TAX_DETAILS_OWNER_ONLY_MESSAGE, 403)
  }
}

/**
 * The 409 a version that no longer matches answers.
 * @returns The error.
 */
function versionConflict(): HttpError {
  return new HttpError(TAX_DETAILS_VERSION_CONFLICT_MESSAGE, 409, TAX_DETAILS_VERSION_CONFLICT_CODE)
}

/**
 * The stored row (or the empty first-save row) with the sent fields
 * applied, and the issues a missing required field or a cross-field rule
 * raises.
 * @param stored - The locked row, or undefined for a first save.
 * @param patch - The fields sent.
 * @param sent - Which fields were sent.
 * @returns The merged values and the issues; the values are complete only when there are no issues.
 */
function mergeAndCheck(
  stored: TenantTaxDetailsRecord | undefined,
  patch: Partial<TaxDetailsValues>,
  sent: ReadonlySet<TaxDetailField>
): { merged: TaxDetailsValues; issues: TaxDetailsRuleIssue[] } {
  const base: Partial<TaxDetailsValues> = stored === undefined ? EMPTY_DETAILS : valuesOf(stored)
  const partial: Partial<TaxDetailsValues> = { ...base, ...patch }
  const required: TaxDetailsRuleIssue[] = []
  if (partial.legalName === undefined) {
    required.push({ field: 'legalName', message: TAX_LEGAL_NAME_REQUIRED_MESSAGE })
  }
  if (partial.stateCode === undefined) {
    required.push({ field: 'stateCode', message: TAX_STATE_REQUIRED_MESSAGE })
  }
  const merged = { ...EMPTY_DETAILS, legalName: '', stateCode: '', ...partial }
  // A field already missing reads its required message only.
  const rules = taxDetailsRuleIssues(merged, sent).filter(
    (issue) => !required.some((missing) => missing.field === issue.field)
  )
  return { merged, issues: [...required, ...rules] }
}

/**
 * Save a workspace's tax details: the first save inserts the row, later
 * ones update the changed columns and add one to `version`. Records
 * `billing.tax_details_updated` with the changed field names (and a staff
 * member's reason) in the same transaction. Nothing is written when no
 * value changes.
 *
 * Lock order: the actor's access first (an owner's owner and membership
 * rows through `lockActorRole`; staff's platform-role and user rows through
 * `assertStillPlatformRole`), then the details row.
 * @param actor - The owner or staff member saving.
 * @param tenantId - The workspace.
 * @param patch - The validated PATCH body, without a staff reason.
 * @param options - How the actor reached the workspace, and the staff reason.
 * @returns The saved details.
 * @throws {HttpError} 404 while registration is off; 403 for anyone but an owner by membership on the owner route; 409 `TAX_DETAILS_VERSION_CONFLICT` when the version no longer matches; 400 when a required field is missing, a cross-field rule fails or nothing changes.
 */
export async function saveTaxDetails(
  actor: Actor,
  tenantId: string,
  patch: TaxDetailsPatch,
  options: SaveTaxDetailsOptions
): Promise<TaxDetailsView> {
  assertTaxWritable()
  if (options.access === 'platform' && options.reason === null) {
    throw new Error('A staff tax details save needs a reason.')
  }
  const { version, ...fields } = patch
  const sentFields: Partial<TaxDetailsValues> = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  )
  const sent = new Set(TAX_DETAIL_FIELDS.filter((field) => sentFields[field] !== undefined))

  return withTransaction(async (tx) => {
    if (options.access === 'platform') await assertStillPlatformRole(actor, 'manager', tx)
    else await lockMemberOwner(actor, tenantId, tx)
    const stored = await taxRepository.lockDetails(tenantId, tx)
    if (stored === undefined ? version !== null : version !== stored.version) {
      throw versionConflict()
    }
    const { merged, issues } = mergeAndCheck(stored, sentFields, sent)
    if (issues.length > 0) throw validationError(issues)

    const before = stored === undefined ? EMPTY_DETAILS : valuesOf(stored)
    const changedFields = TAX_DETAIL_FIELDS.filter(
      (field) => (before as Partial<TaxDetailsValues>)[field] !== merged[field]
    )
    if (changedFields.length === 0) {
      throw new HttpError(VALIDATION_FAILED_MESSAGE, 400, undefined, {
        formErrors: [TAX_DETAILS_NO_CHANGE_MESSAGE],
      })
    }

    const saved =
      stored === undefined
        ? await taxRepository.insertDetails({ tenantId, ...merged, updatedBy: actor.userId }, tx)
        : await taxRepository.updateDetailsVersioned(
            tenantId,
            stored.version,
            Object.fromEntries(changedFields.map((field) => [field, merged[field]])),
            actor.userId,
            tx
          )
    if (saved === undefined) throw versionConflict()

    await record(
      {
        action: 'billing.tax_details_updated',
        actor,
        access: options.access,
        tenantId,
        targetId: tenantId,
        metadata:
          options.access === 'platform' && options.reason !== null
            ? { changedFields, reason: options.reason }
            : { changedFields },
      },
      tx
    )
    return presentTaxDetails(saved)
  })
}
