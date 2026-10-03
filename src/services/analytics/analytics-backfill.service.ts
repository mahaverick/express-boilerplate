/**
 * @file The groups backfill: every tenant's `$groupidentify` (name, status,
 * created_at), sent straight to PostHog page by page with `sendBatch`, never
 * through the outbox, so a run reports at once whether PostHog took it.
 * Idempotent: a second run sets the same properties again. Run once per
 * environment after enabling analytics (`pnpm analytics:backfill-groups`);
 * after that, the audit forwarder keeps the groups current.
 */
import { randomUUID } from 'node:crypto'
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { TenantRepository } from '@/repositories/tenant.repository'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { sendBatch, toPosthogBatchEvent } from '@/services/analytics/posthog-batch.service'

/**
 * Tenants per `/batch/` request.
 */
export const BACKFILL_PAGE_SIZE = 100

/**
 * What a completed backfill sent.
 */
export interface BackfillResult {
  tenants: number
  batches: number
}

const tenantRepository = new TenantRepository()

/**
 * Send every tenant's group properties to PostHog.
 * @param pageSize - Tenants per batch.
 * @returns How many tenants and batches were sent.
 * @throws {Error} When analytics is not configured, or when PostHog does not
 *   acknowledge a batch; the pages before it were sent, none after it.
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
    const sentAt = new Date()
    const answer = await sendBatch(
      page.map((tenant) =>
        toPosthogBatchEvent({
          ...buildTenantGroupIdentify(tenant, {}, 'backfill', 'system', sentAt),
          id: randomUUID(),
          occurredAt: sentAt,
        })
      )
    )
    if (answer.kind !== 'ack') {
      const status = answer.status === undefined ? '' : ` ${String(answer.status)}`
      throw new Error(
        `PostHog answered ${answer.kind}${status} to batch ${String(result.batches + 1)}; ${String(result.tenants)} tenants were sent before it`
      )
    }
    result.tenants += page.length
    result.batches += 1
    afterId = page.at(-1)?.id
    hasMore = page.length === pageSize
  }
  return result
}
