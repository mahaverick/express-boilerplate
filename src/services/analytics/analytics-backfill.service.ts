/**
 * @file The groups backfill: one `$groupidentify` marker per tenant row,
 * archived and soft-deleted ones included, queued in the analytics outbox
 * page by page. The drainer fills each marker with the tenant's state when
 * it sends it (`resolveGroupMarkers`), so the backfill never races a rename:
 * whichever marker reaches PostHog last carries the current state.
 * Idempotent: a second run queues the same markers again. Run once per
 * environment after enabling analytics (`pnpm analytics:backfill-groups`);
 * after that, the audit forwarder keeps the groups current.
 */
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { TenantRepository } from '@/repositories/tenant.repository'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { enqueueAnalyticsOrThrow } from '@/services/analytics/analytics-outbox.service'

/**
 * Tenants per outbox insert.
 */
const BACKFILL_PAGE_SIZE = 100

/**
 * What a completed backfill queued.
 */
export interface BackfillResult {
  tenants: number
  batches: number
}

const tenantRepository = new TenantRepository()

/**
 * Queue a group marker for every tenant.
 * @param pageSize - Tenants per insert.
 * @returns How many tenants and inserts were queued.
 * @throws {Error} When analytics is not configured, or when an insert fails;
 *   the pages before it were queued, none after it.
 */
export async function backfillTenantGroups(
  pageSize: number = BACKFILL_PAGE_SIZE
): Promise<BackfillResult> {
  if (!isAnalyticsEnabled()) throw new Error('POSTHOG_PROJECT_KEY is not set: analytics is off')
  const result: BackfillResult = { tenants: 0, batches: 0 }
  let afterId: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await tenantRepository.listGroupSnapshotsAfter(afterId, pageSize)
    if (page.length === 0) break
    const queuedAt = new Date()
    try {
      await enqueueAnalyticsOrThrow(
        page.map((tenant) => buildTenantGroupIdentify(tenant, {}, 'backfill', queuedAt))
      )
    } catch (error) {
      throw new Error(
        `Queuing batch ${String(result.batches + 1)} failed; ${String(result.tenants)} tenants were queued before it`,
        { cause: error }
      )
    }
    result.tenants += page.length
    result.batches += 1
    afterId = page.at(-1)?.id
    hasMore = page.length === pageSize
  }
  return result
}
