/**
 * @file Staff billing of one customer tenant, behind
 * `/api/v1/platform/tenants/:id/billing`: the read, the resync, the trial
 * extension, grants and their revocation, and the staff cancel. The
 * platform tenant is never billed and answers `tenant_billing_not_found`
 * before any lock or read; an archived tenant stays readable.
 *
 * Every write re-checks the staff member's platform role under lock
 * (`assertStillPlatformRole`, which locks the platform-role row, then the
 * user row), then takes the tenant's billing row, the documented lock order.
 * Provider calls never run inside a transaction. Each write is audited with
 * platform access and the staff member's reason; a write that changes the
 * billing row then runs `emitBillingDiff` with source `staff`, whose events
 * name the payer or the trial's owner, never the staff member. A grant does
 * not change the row, so it pushes the entitlements change itself.
 *
 * A trial extension bypasses the one-trial-per-person rule: it makes no
 * per-person claim. It clears the trial reminder claims, so the reminders
 * run again for the new end. A held unpaid checkout keeps the first charge
 * it was created with; the owner's next checkout re-creates it for the new
 * trial end.
 */
import {
  NO_SUBSCRIPTION_CODE,
  PAYMENT_PROVIDER_UNAVAILABLE_CODE,
  STAFF_BILLING_LIST_LIMIT,
  TRIAL_NOT_EXTENDABLE_CODE,
  type StaffCancelWhen,
} from '@/constants/billing.constants'
import type { EntitlementGrant } from '@/database/models/billing.model'
import type { Tenant } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { displayName } from '@/presenters/billing.presenter'
import {
  toEventView,
  toGrantView,
  toHistoryView,
  type GrantView,
  type StaffTenantBillingView,
} from '@/presenters/platform-billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { trackTrialExtended } from '@/services/billing/billing-analytics.service'
import {
  emitBillingDiff,
  publishEntitlementsChanged,
} from '@/services/billing/billing-events.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import {
  cancelSubscriptions,
  getTenantBillingForStaff,
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
import { extendTrialEnd } from '@/utilities/billing-rules.utilities'
import type { GrantBody } from '@/validators/platform-billing.validators'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
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
async function customerTenant(tenantId: string): Promise<Tenant> {
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
  return new Map(users.map((user) => [user.id, { userId: user.id, name: displayName(user) }]))
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
  return view
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
 * Extend a tenant's trial, or put a Free tenant back on one: the end moves
 * `days` past the later of now and a running trial's end. A Free tenant, or
 * one whose trial already lapsed, starts its trial now. The reminder claims
 * are cleared so the reminders run for the new end, and a wait for the first
 * owner's acceptance is dropped, since staff gave the trial.
 * @param actor - The staff member (a platform manager or above).
 * @param tenantId - The tenant.
 * @param days - Days to add, 1 to `MAX_TRIAL_DAYS` (the body schema checked).
 * @param reason - Why, for the audit log.
 * @returns The staff billing view after the extension.
 * @throws {HttpError} 404s as the read; 409 `TRIAL_NOT_EXTENDABLE` on a paying or past-due tenant.
 */
export async function extendTrial(
  actor: Actor,
  tenantId: string,
  days: number,
  reason: string
): Promise<StaffTenantBillingView> {
  await customerTenant(tenantId)
  const written = await withTransaction(async (tx) => {
    const locked = await lockStaffAndBilling(actor, 'manager', tenantId, tx)
    if (locked.state === 'active' || locked.state === 'past_due') {
      throw new HttpError(
        'This tenant pays for Paid, so it has no trial to extend. Add a grant to give it more.',
        409,
        TRIAL_NOT_EXTENDABLE_CODE
      )
    }
    const now = new Date()
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
 * Cancel a tenant's subscription as staff, by the owner cancel's provider
 * rules (`cancelSubscriptions`): at its cycle end, which this records as
 * cancelling, or now, which moves the tenant to Free. A deferred start that
 * has not charged yet is always cancelled now and goes back to its trial,
 * or to Free when the trial is over. A scheduled switch or resubscribe is
 * cancelled too. A sync follows, so the row matches the provider; its
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
    const held = [row?.providerSubscriptionId, row?.nextSubscriptionId].filter(
      (id) => id !== null && id !== undefined
    )
    if (held.length === 0) throw nothingToCancel
    throw new HttpError(
      "Payments are off on this server, so we can't reach the subscription. Cancel it in the provider's dashboard.",
      502,
      PAYMENT_PROVIDER_UNAVAILABLE_CODE
    )
  }
  await cancelSubscriptions(provider, {
    tenantId,
    source: 'staff',
    when,
    lock: (tx) => lockStaffAndBilling(actor, 'admin', tenantId, tx),
    audit: async (tx) => {
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
    },
    shouldAuditWhenEnded: true,
    nothingToCancel: (row) =>
      Promise.resolve(
        row.cancelAtPeriodEnd
          ? new HttpError(
              'This subscription already ends at its period end. Cancel it now to end it sooner.',
              409,
              NO_SUBSCRIPTION_CODE
            )
          : nothingToCancel
      ),
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
