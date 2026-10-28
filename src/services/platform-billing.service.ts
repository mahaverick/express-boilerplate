/**
 * @file Staff billing, behind `/api/v1/platform`. For one customer tenant
 * (`/tenants/:id/billing`): the read, the resync, the trial extension,
 * grants and their revocation, and the staff cancel. The platform tenant is
 * never billed and answers `tenant_billing_not_found` before any lock or
 * read; an archived tenant stays readable. Platform-wide: the plans with
 * their prices and tenant counts, a plan change's preview, the plan edit, a
 * new price, the billing settings and the alerts list.
 *
 * The read and its paged lists (state history, provider events, held
 * subscriptions and invoices) share one throttled `billing.viewed` audit
 * window.
 *
 * Every write re-checks the staff member's platform role under lock
 * (`assertStillPlatformRole`, which locks the platform-role row, then the
 * user row), then takes the row it changes: a tenant's billing row, the
 * documented lock order, or a plan or the settings row, which no tenant
 * write locks. Provider calls never run inside a transaction. Each write is
 * audited with platform access and the staff member's reason; a write that
 * changes the billing row then runs `emitBillingDiff` with source `staff`,
 * whose events name the payer or the trial's owner, never the staff member.
 * A grant does not change the row, so it pushes the entitlements change
 * itself, and so do a plan edit and a grace change, to every tenant they
 * reach.
 *
 * A trial extension bypasses the one-trial-per-person rule: it makes no
 * per-person claim. It clears the trial reminder claims, so the reminders
 * run again for the new end. A held unpaid checkout keeps the first charge
 * it was created with; the owner's next checkout re-creates it for the new
 * trial end.
 *
 * A plan edit applies to every tenant on the plan at once, and a lowered
 * limit deletes nothing: a tenant over it keeps its members and can add
 * none. A new price retires the active one of its interval; a subscriber
 * keeps the price it pays, and no provider plan is made until the first
 * checkout on the new price. Trial settings apply to trials that start after
 * the change; the past-due grace applies at once to every past-due tenant,
 * since its end is computed on each read.
 */
import { gstEffectiveFromSetting, gstSellerConfig } from '@/configs/billing.config'
import {
  BILLING_STATES,
  NO_SUBSCRIPTION_CODE,
  PAYMENT_PROVIDER_UNAVAILABLE_CODE,
  PLAN_KEYS,
  PLAN_VERSION_CONFLICT_CODE,
  PRICE_WARNING_ABOVE_MINOR,
  STAFF_BILLING_LIST_LIMIT,
  TRIAL_NOT_EXTENDABLE_CODE,
  type BillingState,
  type PlanKey,
  type StaffCancelWhen,
} from '@/constants/billing.constants'
import {
  ENTITLEMENTS,
  entitlementCatalog,
  type EntitlementCatalogEntry,
  type EntitlementDefinition,
  type EntitlementKey,
  type EntitlementValue,
} from '@/constants/entitlements.constants'
import type {
  BillingSettingsRecord,
  EntitlementGrant,
  Plan,
  TenantBillingRecord,
} from '@/database/models/billing.model'
import type { Tenant } from '@/database/models/tenant.model'
import { isUnknownIdError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import {
  addBillingPublishEntitlementsJob,
  type BillingPublishEntitlementsJobData,
} from '@/jobs/billing.job'
import { nameOrEmail } from '@/presenters/billing.presenter'
import {
  toBillingAlertView,
  toEventView,
  toGrantView,
  toHistoryView,
  toStaffInvoiceView,
  toStaffPriceView,
  type BillingAlertView,
  type BillingSettingsView,
  type GrantView,
  type PlanChangePreview,
  type StaffInvoiceView,
  type StaffPlanView,
  type StaffTenantBillingView,
  type TenantStateCounts,
} from '@/presenters/platform-billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import {
  PlatformBillingRepository,
  type BillingEventListItem,
  type BillingHistoryListItem,
  type BillingSubscriptionListItem,
  type TenantBillingStateRow,
} from '@/repositories/platform-billing.repository'
import { PlatformTaxRepository } from '@/repositories/platform-tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { trackTrialExtended } from '@/services/billing/billing-analytics.service'
import {
  emitBillingDiff,
  publishEntitlementsChanged,
} from '@/services/billing/billing-events.service'
import {
  callProvider,
  getBillingProvider,
  providerFailure,
} from '@/services/billing/billing-provider.service'
import {
  BillingSyncConflictError,
  syncTenantBilling,
} from '@/services/billing/billing-sync.service'
import {
  billingBusy,
  cancelSubscriptions,
  ENDED_STATUSES,
  getTenantBillingForStaff,
  listInvoicesForStaff,
  syncOrRetry,
} from '@/services/billing/checkout.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { lockBilling } from '@/services/billing/trial.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { auditThrottledView } from '@/services/platform-view-audit.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import { redisKey } from '@/services/redis.service'
import type { Actor } from '@/types/actor'
import type { BillingProviderClient } from '@/types/billing'
import {
  effectiveBillingState,
  extendTrialEnd,
  heldSubscriptionIds,
  isOtherProvider,
  mergeEntitlements,
  planKeyForState,
} from '@/utilities/billing-rules.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'
import type {
  BillingAlertListQuery,
  BillingEventListQuery,
  BillingHistoryListQuery,
  BillingSubscriptionListQuery,
  CreatePriceBody,
  GrantBody,
  StaffInvoiceListQuery,
  UpdateBillingSettingsBody,
  UpdatePlanBody,
} from '@/validators/platform-billing.validators'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const platformBillingRepository = new PlatformBillingRepository()
const platformTaxRepository = new PlatformTaxRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * What staff read when a cancel finds a row of another provider or mode.
 */
const OTHER_PROVIDER_STAFF_MESSAGE =
  "This subscription is with another payment account or mode. Cancel it in that account's dashboard, then resync."

/**
 * A customer tenant, archived ones included.
 * @param tenantId - The tenant.
 * @returns The tenant.
 * @throws {HttpError} 404 `tenant_not_found` for an unknown tenant; 404 `tenant_billing_not_found` for the platform tenant.
 */
export async function customerTenant(tenantId: string): Promise<Tenant> {
  const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (tenant === undefined) throw notFoundError('platformTenant')
  if (tenant.isPlatform) throw notFoundError('tenantBilling')
  return tenant
}

/**
 * Re-check the staff member's platform role, then lock the tenant's billing
 * row, in the documented lock order.
 * @param actor - The staff member.
 * @param minimum - The platform role the route requires.
 * @param tenantId - The customer tenant.
 * @param tx - The write's transaction.
 * @returns The locked billing row.
 */
async function lockStaffAndBilling(
  actor: Actor,
  minimum: 'manager' | 'admin',
  tenantId: string,
  tx: DbTransaction
) {
  await assertStillPlatformRole(actor, minimum, tx)
  return lockBilling(tenantId, tx)
}

/**
 * The staff members who granted a tenant's grants, soft-deleted accounts
 * included, read in one query.
 * @param grants - The grants.
 * @returns Each granting user's id and name, by id; an account no longer on record is absent.
 */
async function grantersOf(
  grants: readonly EntitlementGrant[]
): Promise<Map<string, NonNullable<GrantView['grantedBy']>>> {
  const ids = [...new Set(grants.map((grant) => grant.grantedBy).filter((id) => id !== null))]
  const users = await userRepository.findManyByIds(ids, { includeDeleted: true })
  return new Map(users.map((user) => [user.id, { userId: user.id, name: nameOrEmail(user) }]))
}

/**
 * A customer tenant's staff billing view.
 * @param tenantId - The customer tenant.
 * @returns The view.
 */
async function staffView(tenantId: string): Promise<StaffTenantBillingView> {
  const read = await getEffectiveEntitlements(tenantId)
  const base = await getTenantBillingForStaff(tenantId, read)
  const row = await billingRepository.findByTenantId(tenantId)
  const { sources, ...entitlements } = read
  const now = new Date()
  const grants = await planRepository.listGrants(tenantId)
  const granters = await grantersOf(grants)
  const history = await billingRepository.listHistory(tenantId, STAFF_BILLING_LIST_LIMIT)
  const events = await billingRepository.listEvents(tenantId, STAFF_BILLING_LIST_LIMIT)
  return {
    ...base,
    provider: row?.provider ?? null,
    providerMode: row?.providerMode ?? null,
    providerSubscriptionId: row?.providerSubscriptionId ?? null,
    pendingSubscriptionId: row?.pendingSubscriptionId ?? null,
    nextSubscriptionId: row?.nextSubscriptionId ?? null,
    syncedAt: row?.syncedAt ?? null,
    disputeOpen: row?.disputeOpen ?? false,
    entitlements,
    sources,
    grants: grants.map((grant) =>
      toGrantView(
        grant,
        grant.grantedBy === null ? null : (granters.get(grant.grantedBy) ?? null),
        now
      )
    ),
    history: history.map((entry) => toHistoryView(entry)),
    events: events.map((event) => toEventView(event)),
    openHeldCharges: await platformTaxRepository.countOpenHeld(tenantId),
    hasHeldCharges: await platformTaxRepository.hasHeld(tenantId),
  }
}

/**
 * A customer tenant's billing as staff read it, audited at most once per
 * staff member and tenant in the view-audit throttle window, and only once
 * the read succeeded.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The tenant.
 * @returns The staff billing view.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant.
 */
export async function getStaffTenantBilling(
  actor: Actor,
  tenantId: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  const view = await staffView(tenantId)
  await auditBillingView(actor, tenantId)
  return view
}

/**
 * Audit a staff read of a customer tenant's billing, at most once per staff
 * member and tenant in the view-audit throttle window. The read and every
 * one of its lists share the window, so opening the billing tab writes one
 * entry.
 * @param actor - The staff member.
 * @param tenantId - The tenant.
 */
export async function auditBillingView(actor: Actor, tenantId: string): Promise<void> {
  await auditThrottledView({
    key: redisKey(
      'billing',
      'audit',
      actor.userId.toLowerCase(),
      'tenant',
      tenantId.toLowerCase(),
      'view'
    ),
    label: 'Tenant billing view',
    kind: 'tenant',
    targetId: tenantId,
    write: async () => {
      await withTransaction(async (tx) => {
        await record(
          {
            action: 'billing.viewed',
            actor,
            access: 'platform',
            tenantId,
            targetId: tenantId,
            metadata: {},
          },
          tx
        )
      })
    },
  })
}

/**
 * One page of a customer tenant's billing state changes, audited as a
 * billing read.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The tenant.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listStaffBillingHistory(
  actor: Actor,
  tenantId: string,
  query: BillingHistoryListQuery
): Promise<ListPage<BillingHistoryListItem>> {
  await customerTenant(tenantId)
  const page = await platformBillingRepository.listHistoryPage(tenantId, query.params, {
    sources: query.filters.source,
  })
  await auditBillingView(actor, tenantId)
  return page
}

/**
 * One page of a customer tenant's provider events, audited as a billing
 * read. An event shows its type, outcome, times and error, never its
 * provider ids or payload.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The tenant.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listStaffBillingEvents(
  actor: Actor,
  tenantId: string,
  query: BillingEventListQuery
): Promise<ListPage<BillingEventListItem>> {
  await customerTenant(tenantId)
  const page = await platformBillingRepository.listEventsPage(tenantId, query.params, {
    statuses: query.filters.status,
  })
  await auditBillingView(actor, tenantId)
  return page
}

/**
 * One page of the subscriptions a customer tenant has held as its current
 * one, audited as a billing read.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The tenant.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listStaffBillingSubscriptions(
  actor: Actor,
  tenantId: string,
  query: BillingSubscriptionListQuery
): Promise<ListPage<BillingSubscriptionListItem>> {
  await customerTenant(tenantId)
  const page = await platformBillingRepository.listSubscriptionsPage(tenantId, query.params, {
    providers: query.filters.provider,
    modes: query.filters.mode,
  })
  await auditBillingView(actor, tenantId)
  return page
}

/**
 * One page of a customer tenant's invoices across every subscription it
 * has held with the running provider and mode, newest first, audited as a
 * billing read. Empty with payments off.
 * @param actor - The staff member (a platform viewer or above; the route checked).
 * @param tenantId - The tenant.
 * @param query - The parsed cursor and status filter.
 * @returns The page; no invoice carries its link.
 * @throws {HttpError} 404 `tenant_not_found`; 404 `tenant_billing_not_found` for the platform tenant; 503 or 502 when the provider fails.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listStaffInvoices(
  actor: Actor,
  tenantId: string,
  query: StaffInvoiceListQuery
): Promise<ListPage<StaffInvoiceView>> {
  await customerTenant(tenantId)
  const page = await listInvoicesForStaff(tenantId, query.cursor, query.status)
  await auditBillingView(actor, tenantId)
  return { ...page, items: page.items.map((invoice) => toStaffInvoiceView(invoice)) }
}

/**
 * Bring a tenant's billing in line with its provider subscriptions now, then
 * audit it. With payments off the sync changes nothing; the resync is still
 * audited. The sync itself sends what its change calls for.
 * @param actor - The staff member (a platform manager or above).
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns The staff billing view after the sync.
 * @throws {HttpError} 404s as the read; 503 or 502 when the provider fails, with nothing audited.
 */
export async function resyncTenantBilling(
  actor: Actor,
  tenantId: string,
  reason: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  // No role re-check before the sync: it changes nothing a caller chose, and the audit below re-checks under lock.
  await syncOrRetry(tenantId, 'staff')
  await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'manager', tx)
    await record(
      {
        action: 'billing.resynced',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { reason },
      },
      tx
    )
  })
  return staffView(tenantId)
}

/**
 * Whether a row is stored as paying but served as Free: its paid time has
 * passed and the billing job has not recorded the move yet.
 * @param row - The billing row.
 * @param graceDays - Days of grace after a halt or pause.
 * @returns True for a lapsed `active` or `past_due` row.
 */
function isLapsed(row: TenantBillingRecord, graceDays: number): boolean {
  if (row.state !== 'active' && row.state !== 'past_due') return false
  return effectiveBillingState(row, new Date(), graceDays) === 'free'
}

/**
 * The answer for a provider read the lapsed sync could not make. A
 * subscription the provider has no record of fails every later sync, the
 * job's and a resync's alike, so it answers a 409 that says who can fix the
 * record: a 5xx body is masked, and staff would read only "try again". Any
 * other failure is the provider's 503 or 502.
 * @param error - What the sync threw.
 * @param refusalCode - The caller's refusal code.
 * @returns The error to throw.
 */
function lapsedSyncFailure(error: unknown, refusalCode: string): Error {
  if (!isUnknownIdError(error)) return providerFailure(error)
  return new HttpError(
    "The payment provider has no record of one of this tenant's subscriptions, so we can't confirm its paid time ended. Ask engineering to check its billing record.",
    409,
    refusalCode
  )
}

/**
 * Sync a tenant whose stored `active` or `past_due` state its paid time has
 * outlived: the billing job's grace and cancelling steps, run now. The
 * history row says `job`, since the transition and its cause are the clock's
 * and identical to the job's, not a choice the staff member made; it carries
 * no staff audit entry for the same reason. A sync that keeps losing to a
 * concurrent write is left to that write when the write moved the row; a row
 * still lapsed afterwards answers the busy 503.
 * @param tenantId - The tenant.
 * @param refusalCode - The caller's 409 code, for a subscription the provider has no record of.
 * @returns The row after the sync, or undefined when the row was not lapsed.
 * @throws {HttpError} 503 `BILLING_BUSY` when the row kept moving and is still lapsed; 409 `refusalCode` for a subscription the provider has no record of; 503 or 502 when another provider read fails, with nothing written.
 */
async function syncIfLapsed(
  tenantId: string,
  refusalCode: string
): Promise<TenantBillingRecord | undefined> {
  const row = await billingRepository.findByTenantId(tenantId)
  const { pastDueGraceDays } = await planRepository.getSettings()
  if (row === undefined || !isLapsed(row, pastDueGraceDays)) return
  let isBusy = false
  try {
    await syncTenantBilling(tenantId, 'job')
  } catch (error) {
    if (!(error instanceof BillingSyncConflictError)) throw lapsedSyncFailure(error, refusalCode)
    isBusy = true
  }
  const after = await billingRepository.findByTenantId(tenantId)
  if (isBusy && after !== undefined && isLapsed(after, pastDueGraceDays)) throw billingBusy()
  return after
}

/**
 * The refusal for an extension whose row is still stored `active` or
 * `past_due` after the lapsed sync, worded by why the sync could not move it.
 * @param row - The locked row.
 * @returns The 409.
 */
function notConfirmedEnded(row: TenantBillingRecord): HttpError {
  const provider = getBillingProvider()
  let message =
    "The payment provider hasn't confirmed this tenant's subscription ended. Resync the tenant, then try again."
  if (provider === null) {
    message =
      "Payments are off on this server, so we can't confirm this tenant's paid time ended. Ask engineering to turn payments on, then try again."
  } else if (isOtherProvider(row, provider)) {
    message =
      "This tenant's subscription is with another payment account or mode, so we can't confirm it ended. Ask engineering to check it in that payment account."
  }
  return new HttpError(message, 409, TRIAL_NOT_EXTENDABLE_CODE)
}

/**
 * Whether a cancel would find nothing to end on a row a lapsed sync just
 * moved to Free. It mirrors `cancelSubscriptions`, which ends only the
 * current and the next subscription and never the pending checkout (an
 * unpaid checkout lapses at the provider; a paid one the sync adopts as
 * current). So the row is on Free, holds no next subscription, and its
 * current one, read again now, has ended.
 * @param provider - The running provider.
 * @param row - The row after the sync.
 * @returns True when nothing is left to cancel.
 * @throws {HttpError} 503 or 502 when the provider read fails.
 */
async function hasNothingLeftToCancel(
  provider: BillingProviderClient,
  row: TenantBillingRecord
): Promise<boolean> {
  if (row.state !== 'free' || row.nextSubscriptionId !== null) return false
  const currentId = row.providerSubscriptionId
  if (currentId === null) return true
  const current = await callProvider(() => provider.fetchSubscription(currentId))
  return ENDED_STATUSES.has(current.status)
}

/**
 * Extend a tenant's trial, or put a Free tenant back on one: the end moves
 * `days` past the later of now and a running trial's end. A Free tenant, or
 * one whose trial already lapsed, starts its trial now. The reminder claims
 * are cleared so the reminders run for the new end, and a wait for the first
 * owner's acceptance is dropped, since staff gave the trial.
 *
 * A tenant stored `active` or `past_due` whose paid time has passed is
 * served as Free (`effectiveBillingState`) before the billing job records
 * it. It is synced first, as the job's grace and cancelling steps do, so the
 * move to Free lands with the job's history cause; the sync takes the row
 * lock itself and calls the provider with no lock held. The decision is then
 * made under this write's lock, on the row's effective state. A row still
 * stored `active` or `past_due` after the sync is refused (`notConfirmedEnded`):
 * the provider did not confirm the subscription ended, and its next sync
 * would make the tenant active again.
 * @param actor - The staff member (a platform manager or above).
 * @param tenantId - The tenant.
 * @param days - Days to add, 1 to `MAX_TRIAL_DAYS` (the body schema checked).
 * @param reason - Why, for the audit log.
 * @returns The staff billing view after the extension.
 * @throws {HttpError} 404s as the read; 409 `TRIAL_NOT_EXTENDABLE` on a paying or past-due tenant, or one whose end the provider has not confirmed; 503 `BILLING_BUSY` when the lapsed row keeps moving; 503 or 502 when the provider read fails, with nothing written.
 */
export async function extendTrial(
  actor: Actor,
  tenantId: string,
  days: number,
  reason: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  // No role re-check before the sync: it changes nothing a caller chose, and the write below re-checks under lock.
  await syncIfLapsed(tenantId, TRIAL_NOT_EXTENDABLE_CODE)
  const written = await withTransaction(async (tx) => {
    const locked = await lockStaffAndBilling(actor, 'manager', tenantId, tx)
    const now = new Date()
    const { pastDueGraceDays } = await planRepository.getSettings(tx)
    const effective = effectiveBillingState(locked, now, pastDueGraceDays)
    if (effective === 'active' || effective === 'past_due') {
      throw new HttpError(
        'This tenant pays for Paid, so it has no trial to extend. Add a grant to give it more.',
        409,
        TRIAL_NOT_EXTENDABLE_CODE
      )
    }
    if (locked.state === 'active' || locked.state === 'past_due') throw notConfirmedEnded(locked)
    const isRunning =
      locked.state === 'trialing' && locked.trialEndsAt !== null && locked.trialEndsAt > now
    const trialEndsAt = extendTrialEnd(isRunning ? locked.trialEndsAt : null, now, days)
    const paid = await planRepository.findPlanByKey('paid', tx)
    if (paid === undefined) throw new HttpError('The paid plan is missing', 500)
    const after = await billingRepository.updateVersioned(
      tenantId,
      locked.version,
      {
        state: 'trialing',
        planId: paid.id,
        trialEndsAt,
        ...(!isRunning && { trialStartedAt: now }),
        trialOnOwnerAccept: false,
        trialMidpointSentAt: null,
        trialReminder3dSentAt: null,
        trialReminderLastDaySentAt: null,
      },
      tx
    )
    if (after === undefined) throw new HttpError('The billing record changed under its lock', 500)
    await billingRepository.appendHistory(
      {
        tenantId,
        fromState: locked.state,
        toState: 'trialing',
        cause: 'trial_extended',
        source: 'staff',
      },
      tx
    )
    await record(
      {
        action: 'billing.trial_extended',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { days, reason, trialEndsAt: trialEndsAt.toISOString() },
      },
      tx
    )
    return { before: locked, after }
  })
  await emitBillingDiff(written.before, written.after, 'staff')
  await trackTrialExtended(written.after, days)
  return staffView(tenantId)
}

/**
 * Push an entitlements change to the tenant's open apps. Never rejects: the
 * change is committed, and a missed push only delays the app until its next read.
 * @param tenantId - The tenant.
 */
async function publishQuietly(tenantId: string): Promise<void> {
  try {
    await publishEntitlementsChanged(tenantId)
  } catch (error) {
    logger.error('Could not push an entitlements change', { error, tenantId })
  }
}

/**
 * Grant a tenant an entitlement beyond its plan: a limit raised (or
 * uncapped with null) or a feature turned on, until `expiresAt` or for good.
 * The most generous of the plan and its grants wins, so a grant never
 * lowers access. The body is validated against the registry before this
 * runs. The write holds the billing row, the seat lock, so a seat-adding
 * write never reads a half-applied grant.
 * @param actor - The staff member (a platform manager or above).
 * @param tenantId - The tenant.
 * @param body - The key, value, expiry and reason.
 * @returns The staff billing view with the grant.
 * @throws {HttpError} 404s as the read.
 */
export async function addGrant(
  actor: Actor,
  tenantId: string,
  body: GrantBody
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  const expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt)
  await withTransaction(async (tx) => {
    await lockStaffAndBilling(actor, 'manager', tenantId, tx)
    await planRepository.insertGrant(
      {
        tenantId,
        key: body.key,
        value: body.value,
        reason: body.reason,
        grantedBy: actor.userId,
        expiresAt,
      },
      tx
    )
    await record(
      {
        action: 'billing.grant_added',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: {
          key: body.key,
          value: body.value,
          expiresAt: expiresAt?.toISOString() ?? null,
          reason: body.reason,
        },
      },
      tx
    )
  })
  await publishQuietly(tenantId)
  return staffView(tenantId)
}

/**
 * Revoke one of a tenant's grants. A grant of another tenant reads as
 * unknown. A grant already revoked is answered as it stands, with no second
 * audit entry; an expired one can still be revoked, which records why.
 * @param actor - The staff member (a platform manager or above).
 * @param tenantId - The tenant.
 * @param grantId - The grant.
 * @param reason - Why, for the audit log.
 * @returns The staff billing view after the revoke.
 * @throws {HttpError} 404s as the read; 404 `grant_not_found` for a grant this tenant does not have.
 */
export async function revokeGrant(
  actor: Actor,
  tenantId: string,
  grantId: string,
  reason: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  const isRevoked = await withTransaction(async (tx) => {
    await lockStaffAndBilling(actor, 'manager', tenantId, tx)
    const grant = await planRepository.lockGrant(tenantId, grantId, tx)
    if (grant === undefined) throw notFoundError('grant')
    if (grant.revokedAt !== null) return false
    await planRepository.revokeGrant(tenantId, grantId, actor.userId, tx)
    await record(
      {
        action: 'billing.grant_revoked',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { key: grant.key, reason },
      },
      tx
    )
    return true
  })
  if (isRevoked) await publishQuietly(tenantId)
  return staffView(tenantId)
}

/**
 * The 409 a staff cancel answers when it finds nothing to end, worded for
 * the row. A paying row whose cancel is already scheduled says so. A row
 * not paying (Free, or a trial) that still holds a subscription id names it: the cancel ends only a
 * paying row's subscription, and the id most often names one that ended, but
 * a resync ends one that still runs.
 * @param row - The locked row.
 * @param fallback - The answer for a row that holds no subscription.
 * @returns The error.
 */
function staffNothingToCancel(row: TenantBillingRecord, fallback: HttpError): HttpError {
  const isPaying = row.state === 'active' || row.state === 'past_due'
  if (isPaying && row.cancelAtPeriodEnd) {
    return new HttpError(
      'This subscription already ends at its period end. Cancel it now to end it sooner.',
      409,
      NO_SUBSCRIPTION_CODE
    )
  }
  if (!isPaying && row.providerSubscriptionId !== null) {
    return new HttpError(
      `This tenant isn't paying, so a cancel has nothing to end. If the provider shows subscription ${row.providerSubscriptionId} running, resync the tenant.`,
      409,
      NO_SUBSCRIPTION_CODE
    )
  }
  return fallback
}

/**
 * Cancel a tenant's subscription as staff, by the owner cancel's provider
 * rules (`cancelSubscriptions`): at its cycle end, which this records as
 * cancelling, or now, which moves the tenant to Free. A deferred start that
 * has not charged yet is always cancelled now and goes back to its trial,
 * or to Free when the trial is over. A scheduled switch or resubscribe is
 * cancelled too. A row its paid time has outlived is synced first
 * (`syncIfLapsed`), so its move to Free carries the billing job's cause
 * rather than this cancel's; when that sync moves it to Free, its
 * subscription has ended and the cancel is only audited. A sync follows, so the row matches the provider; its
 * failure is logged, since the cancel itself is done. A subscription that
 * had already ended is only synced, and the cancel is still audited.
 *
 * A staff member whose role is revoked after the provider call and before
 * the write is refused at the write's lock with the route's 404: the
 * provider cancel stands, no audit entry is written, and the next sync
 * records the cancel. The owner's cancel has the same shape (its refusal is
 * the role 403).
 * @param actor - The staff member (a platform admin or above).
 * @param tenantId - The tenant.
 * @param when - When the subscription ends.
 * @param reason - Why, for the audit log.
 * @returns The staff billing view after the cancel.
 * @throws {HttpError} 404s as the read; 409 `NO_SUBSCRIPTION` with nothing to cancel; 502 when payments are off but the tenant holds a subscription; 503 or 502 when the provider fails, with nothing written.
 */
export async function cancelByStaff(
  actor: Actor,
  tenantId: string,
  when: StaffCancelWhen,
  reason: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  const nothingToCancel = new HttpError(
    'This tenant has no subscription to cancel. Resync it if the provider shows one.',
    409,
    NO_SUBSCRIPTION_CODE
  )
  const provider = getBillingProvider()
  if (provider === null) {
    const row = await billingRepository.findByTenantId(tenantId)
    // Every id, a checkout too: this server can't tell whether any of them still charges.
    if (row === undefined || heldSubscriptionIds(row).length === 0) throw nothingToCancel
    throw new HttpError(
      "Payments are off on this server, so we can't reach the subscription. Cancel it in the provider's dashboard.",
      502,
      PAYMENT_PROVIDER_UNAVAILABLE_CODE
    )
  }
  /**
   * Record the staff cancel in the write's transaction.
   * @param tx - The write's transaction.
   */
  const audit = async (tx: DbTransaction): Promise<void> => {
    await record(
      {
        action: 'billing.cancelled_by_staff',
        actor,
        access: 'platform',
        tenantId,
        targetId: tenantId,
        metadata: { when, reason },
      },
      tx
    )
  }
  // As the extension does: a lapsed row moves to Free by the job's cause before the cancel reads it.
  const synced = await syncIfLapsed(tenantId, NO_SUBSCRIPTION_CODE)
  if (synced !== undefined && (await hasNothingLeftToCancel(provider, synced))) {
    // As for a subscription that ended before, the cancel is only audited.
    const isAudited = await withTransaction(async (tx) => {
      const locked = await lockStaffAndBilling(actor, 'admin', tenantId, tx)
      // A write since the check that changed what a cancel ends (an adopted checkout, an extension, a switch) sends it down the normal path; a sync that only stamped the row does not.
      const isUnchanged =
        locked.state === synced.state &&
        locked.providerSubscriptionId === synced.providerSubscriptionId &&
        locked.nextSubscriptionId === synced.nextSubscriptionId
      if (!isUnchanged) return false
      await audit(tx)
      return true
    })
    if (isAudited) return staffView(tenantId)
  }
  await cancelSubscriptions(provider, {
    tenantId,
    source: 'staff',
    when,
    lock: (tx) => lockStaffAndBilling(actor, 'admin', tenantId, tx),
    audit,
    shouldAuditWhenEnded: true,
    nothingToCancel: (row) => Promise.resolve(staffNothingToCancel(row, nothingToCancel)),
    otherProviderMessage: OTHER_PROVIDER_STAFF_MESSAGE,
  })
  try {
    await syncTenantBilling(tenantId, 'staff')
  } catch (error) {
    logger.warn('A sync after a staff cancel failed; the next sync finishes it', {
      error,
      tenantId,
    })
  }
  return staffView(tenantId)
}

/**
 * How many tenants' billing records one query reads when a plan edit or a
 * grace change finds the tenants to tell.
 */
const PUBLISH_BATCH_SIZE = 500

/**
 * The staff plan list: both plans, the registry's catalog, and the price
 * above which Apex asks staff to confirm.
 */
interface StaffPlansView {
  plans: StaffPlanView[]
  catalog: Pick<EntitlementCatalogEntry, 'key' | 'kind' | 'label' | 'description'>[]
  priceWarningAboveMinor: typeof PRICE_WARNING_ABOVE_MINOR
}

/**
 * The 409 a plan or settings edit answers when someone else saved first.
 * @param what - What was edited, as staff read it.
 * @returns The error.
 */
function versionConflict(what: 'plan' | 'billing settings'): HttpError {
  return new HttpError(
    `Someone changed the ${what} after you opened this page. Reload it, then try again.`,
    409,
    PLAN_VERSION_CONFLICT_CODE
  )
}

/**
 * Live customer tenants by the state each record stores, counted under the
 * plan that state serves: Paid for trialing, active and past due, Free for
 * free. A lapsed trial or period counts under its stored state until the
 * billing job moves it.
 * @param counts - Tenants by stored plan and state.
 * @param key - The plan.
 * @returns A count for every state, zero for the states the plan does not serve.
 */
function countsServedBy(
  counts: Record<PlanKey, Record<BillingState, number>>,
  key: PlanKey
): TenantStateCounts {
  const result = Object.fromEntries(BILLING_STATES.map((state) => [state, 0])) as TenantStateCounts
  for (const state of BILLING_STATES) {
    if (planKeyForState(state) !== key) continue
    result[state] = PLAN_KEYS.reduce((sum, plan) => sum + counts[plan][state], 0)
  }
  return result
}

/**
 * Every entitlement of a plan, a key it does not set reading its registry default.
 * @param key - The plan's key.
 * @param values - The plan's stored values.
 * @returns A value for every registry key.
 */
function planValues(
  key: PlanKey,
  values: Record<string, EntitlementValue>
): Record<EntitlementKey, EntitlementValue> {
  return mergeEntitlements(key, values, [], new Date()).values
}

/**
 * A plan as staff see it.
 * @param plan - The plan row.
 * @param counts - Tenants by stored plan and state.
 * @param subscribers - Paying tenants by price id.
 * @returns The staff plan view.
 */
async function staffPlanOf(
  plan: Plan,
  counts: Record<PlanKey, Record<BillingState, number>>,
  subscribers: Record<string, number>
): Promise<StaffPlanView> {
  const prices = await planRepository.listPrices(plan.id)
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description ?? '',
    version: plan.version,
    entitlements: planValues(plan.key, plan.entitlements),
    prices: prices.map((price) => toStaffPriceView(price, subscribers[price.id] ?? 0)),
    tenantCounts: countsServedBy(counts, plan.key),
  }
}

/**
 * One plan as staff see it, read after a write.
 * @param plan - The plan row.
 * @returns The staff plan view.
 */
async function staffPlanView(plan: Plan): Promise<StaffPlanView> {
  return staffPlanOf(
    plan,
    await platformBillingRepository.countTenantsByPlanAndState(),
    await platformBillingRepository.countSubscribersByPrice()
  )
}

/**
 * Both plans as staff see them, with the entitlement catalog.
 * @returns The staff plan list.
 */
export async function listStaffPlans(): Promise<StaffPlansView> {
  const rows = await planRepository.listPlans()
  const counts = await platformBillingRepository.countTenantsByPlanAndState()
  const subscribers = await platformBillingRepository.countSubscribersByPrice()
  const plans: StaffPlanView[] = []
  for (const plan of rows) plans.push(await staffPlanOf(plan, counts, subscribers))
  return {
    plans,
    catalog: entitlementCatalog().map(({ key, kind, label, description }) => ({
      key,
      kind,
      label,
      description,
    })),
    priceWarningAboveMinor: PRICE_WARNING_ABOVE_MINOR,
  }
}

/**
 * A plan's stored values with the sent ones written over them: keys not
 * sent keep their values. The edit stores this, and the preview compares it.
 * @param plan - The plan row.
 * @param sent - The entitlements the edit sends.
 * @returns The values to store.
 */
function nextEntitlements(
  plan: Plan,
  sent: Record<string, EntitlementValue>
): Record<string, EntitlementValue> {
  return { ...plan.entitlements, ...sent }
}

/**
 * Whether moving an entitlement from one value to another gives tenants more.
 * @param key - The registry key.
 * @param from - The value now.
 * @param to - The value after.
 * @returns `increase` when tenants get more, `decrease` when less.
 */
function directionOf(
  key: EntitlementKey,
  from: EntitlementValue,
  to: EntitlementValue
): 'increase' | 'decrease' {
  const definition: EntitlementDefinition = ENTITLEMENTS[key]
  if (definition.kind === 'feature') return to === true ? 'increase' : 'decrease'
  if (to === null) return 'increase'
  if (from === null) return 'decrease'
  return Number(to) > Number(from) ? 'increase' : 'decrease'
}

/**
 * What a plan edit would change, key by key in registry order, and how many
 * tenants the plan serves by stored state. Nothing is written; the edit
 * computes the same.
 * @param planId - The plan.
 * @param sent - The entitlements the edit would send (the body schema checked them).
 * @returns The changes and the tenants affected.
 * @throws {HttpError} 404 `plan_not_found`.
 */
export async function previewPlanChange(
  planId: string,
  sent: Record<string, EntitlementValue>
): Promise<PlanChangePreview> {
  const plan = await planRepository.findPlan(planId)
  if (plan === undefined) throw notFoundError('plan')
  const before = planValues(plan.key, plan.entitlements)
  const after = planValues(plan.key, nextEntitlements(plan, sent))
  const changes = (Object.keys(ENTITLEMENTS) as EntitlementKey[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      key,
      from: before[key],
      to: after[key],
      direction: directionOf(key, before[key], after[key]),
    }))
  const counts = await platformBillingRepository.countTenantsByPlanAndState()
  return { changes, affected: countsServedBy(counts, plan.key) }
}

/**
 * Tell the open apps of every live customer tenant a predicate picks, a
 * page of `PUBLISH_BATCH_SIZE` billing records at a time. One tenant's
 * failed push is logged and the rest go on.
 * @param shouldTell - Whether a tenant's record calls for a push.
 * @throws {Error} When a page cannot be read, so the job retries.
 */
async function publishWhere(shouldTell: (row: TenantBillingStateRow) => boolean): Promise<void> {
  let after: string | undefined
  for (;;) {
    const page = await platformBillingRepository.pageBillingStates(after, PUBLISH_BATCH_SIZE)
    for (const row of page) if (shouldTell(row)) await publishQuietly(row.tenantId)
    if (page.length < PUBLISH_BATCH_SIZE) return
    after = page.at(-1)?.tenantId
  }
}

/**
 * Push a staff plan or grace edit to the open apps of the workspaces it
 * changed, the body of the billing queue's `publish-entitlements` job. A
 * plan edit reaches every workspace whose effective plan is the plan; a
 * grace change every one whose effective state differs between the old and
 * the new grace, a lapsed active period's included. Both are read at the
 * edit's time.
 * @param data - What the edit changed, and when.
 * @throws {Error} When the settings or a page cannot be read, so the job retries.
 */
export async function publishEntitlementsChange(
  data: BillingPublishEntitlementsJobData
): Promise<void> {
  const at = new Date(data.at)
  if (data.change === 'grace') {
    await publishWhere(
      (row) =>
        effectiveBillingState(row, at, data.fromDays) !==
        effectiveBillingState(row, at, data.toDays)
    )
    return
  }
  const settings = await planRepository.getSettings()
  await publishWhere(
    (row) =>
      planKeyForState(effectiveBillingState(row, at, settings.pastDueGraceDays)) === data.planKey
  )
}

/**
 * Queue the push of a committed staff edit. Never rejects: the edit stands,
 * and a missed push only delays an app until its next read.
 * @param data - What the edit changed, and when.
 */
async function queuePublish(data: BillingPublishEntitlementsJobData): Promise<void> {
  try {
    await addBillingPublishEntitlementsJob(data)
  } catch (error) {
    logger.error('Could not queue an entitlements push', { error, change: data.change })
  }
}

/**
 * A plan's columns as its audit entry records them.
 * @param plan - The plan row.
 * @returns Its name, description and every entitlement.
 */
function planSnapshot(plan: Plan) {
  return {
    name: plan.name,
    description: plan.description ?? '',
    entitlements: planValues(plan.key, plan.entitlements),
  }
}

/**
 * Edit a plan's name, description or entitlements. The edit applies to every
 * tenant on the plan at once; a lowered limit deletes nothing. Sent
 * entitlements replace those keys' values, as the preview showed. After the
 * commit, every tenant whose effective plan is this one is told, by a queued
 * billing job so the edit answers at once (`publishEntitlementsChange`):
 * trialing ones for Paid, and for Free the free ones and those whose trial
 * or period lapsed before the billing job ran.
 * @param actor - The staff member (a platform admin or above).
 * @param planId - The plan.
 * @param body - The version read, the changes and the reason (the body schema checked them).
 * @returns The plan as staff see it after the edit.
 * @throws {HttpError} 404 `plan_not_found`; 409 `PLAN_VERSION_CONFLICT` for a stale version.
 */
export async function updatePlan(
  actor: Actor,
  planId: string,
  body: UpdatePlanBody
): Promise<StaffPlanView> {
  const updated = await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const locked = await planRepository.lockPlan(planId, tx)
    if (locked === undefined) throw notFoundError('plan')
    if (locked.version !== body.version) throw versionConflict('plan')
    const after = await planRepository.updatePlanVersioned(
      planId,
      locked.version,
      {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && {
          description: body.description === '' ? null : body.description,
        }),
        ...(body.entitlements !== undefined && {
          entitlements: nextEntitlements(locked, body.entitlements),
        }),
      },
      tx
    )
    if (after === undefined) throw new HttpError('The plan changed under its lock', 500)
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (platform === undefined) throw new HttpError('The platform tenant is missing', 500)
    const counts = await platformBillingRepository.countTenantsByPlanAndState(tx)
    const affected = countsServedBy(counts, locked.key)
    await record(
      {
        action: 'plan.updated',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: planId,
        metadata: {
          before: planSnapshot(locked),
          after: planSnapshot(after),
          affected: {
            trialing: affected.trialing,
            active: affected.active,
            past_due: affected.past_due,
            free: affected.free,
          },
          reason: body.reason,
        },
      },
      tx
    )
    return after
  })
  await queuePublish({ change: 'plan', planKey: updated.key, at: new Date().toISOString() })
  return staffPlanView(updated)
}

/**
 * Add a price to Paid for an interval. In the same transaction the active
 * price of that interval is retired; a tenant paying it keeps it, a checkout
 * already open at it completes at it, and new checkouts get the new one. No provider call: the provider plan is made at
 * the first checkout on the price. A price above `PRICE_WARNING_ABOVE_MINOR`
 * is allowed; Apex asks staff to confirm it first.
 * @param actor - The staff member (a platform admin or above).
 * @param planId - The plan.
 * @param body - The interval, amount and reason (the body schema checked them).
 * @returns The plan as staff see it, with the new price.
 * @throws {HttpError} 404 `plan_not_found`; 400 for Free, which has no prices; 409 when another price change won the slot.
 */
export async function createPrice(
  actor: Actor,
  planId: string,
  body: CreatePriceBody
): Promise<StaffPlanView> {
  const plan = await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const locked = await planRepository.lockPlan(planId, tx)
    if (locked === undefined) throw notFoundError('plan')
    if (locked.key === 'free') {
      throw new HttpError('Free has no price. Add the price to Paid instead.', 400)
    }
    await planRepository.insertPriceRetiringActive(
      { planId, currency: 'INR', interval: body.interval, amountMinor: body.amountMinor },
      tx
    )
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (platform === undefined) throw new HttpError('The platform tenant is missing', 500)
    await record(
      {
        action: 'plan.price_created',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: planId,
        metadata: { interval: body.interval, amountMinor: body.amountMinor, reason: body.reason },
      },
      tx
    )
    return locked
  })
  return staffPlanView(plan)
}

/**
 * The settings as staff see them.
 * @param settings - The settings row.
 * @returns The view, naming the staff member who changed them last.
 */
async function settingsView(settings: BillingSettingsRecord): Promise<BillingSettingsView> {
  const [editor] =
    settings.updatedBy === null
      ? []
      : await userRepository.findManyByIds([settings.updatedBy], { includeDeleted: true })
  return {
    trialEnabled: settings.trialEnabled,
    trialDays: settings.trialDays,
    pastDueGraceDays: settings.pastDueGraceDays,
    version: settings.version,
    updatedAt: settings.updatedAt,
    updatedBy: editor === undefined ? null : { userId: editor.id, name: nameOrEmail(editor) },
    taxDocumentsEnabled: gstSellerConfig() !== null,
    hasTaxDocuments: await platformTaxRepository.hasAnyDocuments(),
    gstEffectiveFrom: gstEffectiveFromSetting(),
  }
}

/**
 * The platform-wide trial and grace settings.
 * @returns The settings, with their version and last editor.
 */
export async function getBillingSettings(): Promise<BillingSettingsView> {
  return settingsView(await planRepository.getSettings())
}

/**
 * Change the trial switch, the trial length or the past-due grace. Trial
 * settings apply to trials that start after the change. The grace applies
 * at once to every past-due tenant, since its end is computed on each read;
 * the tenants whose effective state the change moves, a lapsed active
 * period's included, are told after the commit by a queued billing job.
 * @param actor - The staff member (a platform admin or above).
 * @param body - The version read, the changes and the reason (the body schema checked them).
 * @returns The settings after the change.
 * @throws {HttpError} 409 `PLAN_VERSION_CONFLICT` for a stale version.
 */
export async function updateBillingSettings(
  actor: Actor,
  body: UpdateBillingSettingsBody
): Promise<BillingSettingsView> {
  const { before, after } = await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const locked = await planRepository.lockSettings(tx)
    if (locked.version !== body.version) throw versionConflict('billing settings')
    const fields = ['trialEnabled', 'trialDays', 'pastDueGraceDays'] as const
    const changedFields = fields.filter(
      (field) => body[field] !== undefined && body[field] !== locked[field]
    )
    const written = await planRepository.updateSettingsVersioned(
      locked.version,
      {
        ...(body.trialEnabled !== undefined && { trialEnabled: body.trialEnabled }),
        ...(body.trialDays !== undefined && { trialDays: body.trialDays }),
        ...(body.pastDueGraceDays !== undefined && { pastDueGraceDays: body.pastDueGraceDays }),
        updatedBy: actor.userId,
      },
      tx
    )
    if (written === undefined) throw new HttpError('The settings changed under their lock', 500)
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (platform === undefined) throw new HttpError('The platform tenant is missing', 500)
    await record(
      {
        action: 'billing.settings_updated',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: platform.id,
        metadata: { changedFields: [...changedFields], reason: body.reason },
      },
      tx
    )
    return { before: locked, after: written }
  })
  if (before.pastDueGraceDays !== after.pastDueGraceDays) {
    await queuePublish({
      change: 'grace',
      fromDays: before.pastDueGraceDays,
      toDays: after.pastDueGraceDays,
      at: new Date().toISOString(),
    })
  }
  return settingsView(after)
}

/**
 * One page of billing alerts, newest first unless asked otherwise.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listBillingAlerts(
  query: BillingAlertListQuery
): Promise<ListPage<BillingAlertView>> {
  const page = await platformBillingRepository.listAlerts(query.params)
  return { ...page, items: page.items.map((row) => toBillingAlertView(row)) }
}
