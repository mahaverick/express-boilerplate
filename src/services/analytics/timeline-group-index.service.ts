/**
 * @file The index PostHog gave the `tenant` group type, read once from
 * `groups_types/` and kept for the life of the process. SP5a's rollout asks
 * for index 0, but nothing enforces it. A missing type is not kept, so the
 * next request asks again once an operator adds it.
 */
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import { posthogApi, posthogProjectPath } from '@/services/analytics/posthog-api.service'
import { logTimelineFailure } from '@/services/analytics/timeline-query.service'
import { logger } from '@/services/logger.service'

const TENANT_GROUP_TYPE = 'tenant'
const MAX_GROUP_TYPE_INDEX = 4

/**
 * The cached index, once found.
 */
const cache: { index: number | undefined } = { index: undefined }

/**
 * The `tenant` entry's index in a `groups_types/` answer.
 * @param json - The parsed answer.
 * @returns The index; undefined when there is no `tenant` entry; null when
 *   the answer is not a list of group types.
 */
function tenantIndexIn(json: unknown): number | undefined | null {
  // eslint-disable-next-line unicorn/no-null -- null marks an unusable answer, apart from "no tenant type"
  if (!Array.isArray(json)) return null
  for (const entry of json as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { group_type: groupType, group_type_index: index } = entry as Record<string, unknown>
    if (groupType !== TENANT_GROUP_TYPE) continue
    const isValidIndex =
      typeof index === 'number' &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index <= MAX_GROUP_TYPE_INDEX
    // eslint-disable-next-line unicorn/no-null -- null marks an unusable answer, apart from "no tenant type"
    return isValidIndex ? index : null
  }
  return undefined
}

/**
 * The `tenant` group type's index, from the cache or from PostHog.
 * @returns The index, or undefined when the project has no `tenant` group
 *   type (logged at `error`; nothing is cached).
 * @throws {TimelineUnavailableError} When PostHog fails, times out or
 *   answers in an unexpected shape (logged by cause).
 */
export async function tenantGroupTypeIndex(): Promise<number | undefined> {
  if (cache.index !== undefined) return cache.index
  const result = await posthogApi('GET', posthogProjectPath('groups_types/'))
  if (result.kind !== 'ok') {
    logTimelineFailure(result, 'group types')
    throw new TimelineUnavailableError()
  }
  const index = tenantIndexIn(result.json)
  if (index === null) {
    logger.error('PostHog answered the group types call in an unexpected shape')
    throw new TimelineUnavailableError()
  }
  if (index === undefined) {
    logger.error('PostHog has no "tenant" group type, so tenant timelines are unavailable', {
      groupType: TENANT_GROUP_TYPE,
    })
    return undefined
  }
  cache.index = index
  return index
}

/**
 * Forget the cached index, so the next call asks PostHog again. For tests.
 */
export function resetTenantGroupTypeIndexCache(): void {
  cache.index = undefined
}
