/**
 * @file The staff timelines behind `GET /platform/users/:id/timeline` and
 * `GET /platform/tenants/:id/timeline`: what a user or a tenant did, read
 * from PostHog. The routes check for platform admin first. Each request runs
 * in this order: the cursor is checked (400), the target looked up (404),
 * the configuration checked (`configured: false`, nothing audited, PostHog
 * not called), the view audited, the 30 s Redis cache read, the hourly
 * budget taken, and only then PostHog asked. Every request is audited, a
 * cursor page included (a cursor is client input, so a forged one must not
 * skip the audit), at most once per staff member, target and view every
 * `TIMELINE_AUDIT_THROTTLE_SECONDS`. The audit comes before the cache read,
 * so a cached page is audited too, and a later PostHog failure does not undo
 * it: it records that staff asked to look. Rows keep their server fields
 * only when their signature verifies (timeline-mapper.service.ts). This is
 * the one request path that calls PostHog.
 */
import { isTimelineEnabled, timelineLinks } from '@/configs/analytics.config'
import { SYSTEM_DISTINCT_ID } from '@/constants/analytics.constants'
import {
  TIMELINE_AUDIT_THROTTLE_SECONDS,
  TIMELINE_CACHE_TTL_SECONDS,
  TIMELINE_PAGE_SIZE,
} from '@/constants/timeline.constants'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import {
  PlatformUserRepository,
  type PlatformUserLabel,
} from '@/repositories/platform-user.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { posthogApi, posthogProjectPath } from '@/services/analytics/posthog-api.service'
import { takeTimelineQueryBudget } from '@/services/analytics/timeline-budget.service'
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '@/services/analytics/timeline-cursor.service'
import { tenantGroupTypeIndex } from '@/services/analytics/timeline-group-index.service'
import { cursorAfter, mapTimelineResults } from '@/services/analytics/timeline-mapper.service'
import { buildTimelineQuery, logTimelineFailure } from '@/services/analytics/timeline-query.service'
import { recordTimelineView } from '@/services/audit.service'
import { logger } from '@/services/logger.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { Actor } from '@/types/actor'
import type {
  TenantTimelineRow,
  TimelineActor,
  TimelineCursor,
  TimelineKind,
  TimelinePage,
  TimelineQueryInput,
  TimelineRow,
} from '@/types/timeline'

const platformUserRepository = new PlatformUserRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * The cache key of one page: kind, target, range, view and cursor (`first`
 * for a first page).
 * @param kind - Whose timeline.
 * @param id - The user or tenant id.
 * @param input - The validated query.
 * @returns The Redis key.
 */
function cacheKey(kind: TimelineKind, id: string, input: TimelineQueryInput): string {
  return redisKey('timeline', 'v1', kind, id, input.range, input.view, input.before ?? 'first')
}

/**
 * The decoded cursor of a later page.
 * @param before - The raw `before` value, if any.
 * @returns The cursor, or undefined on a first page.
 * @throws {HttpError} 400 when `before` is not a cursor this API issues.
 */
function cursorOf(before: string | undefined): TimelineCursor | undefined {
  if (before === undefined) return undefined
  const cursor = decodeTimelineCursor(before)
  if (cursor === undefined) {
    throw new HttpError('Validation failed', 400, undefined, { before: ['before is invalid.'] })
  }
  return cursor
}

/**
 * Audit a timeline read, at most once per staff member, target and view
 * every `TIMELINE_AUDIT_THROTTLE_SECONDS`: the entry is written only when
 * `SET NX EX` claims the throttle key. A Redis failure writes the entry
 * anyway, logged at `warn`; a failed write releases the key it claimed, so
 * the next read is audited.
 * @param actor - The staff member.
 * @param kind - Whose timeline.
 * @param id - The user or tenant id.
 * @param input - The validated query; the entry records its range and view.
 * @returns Resolves once written, or once the throttle said it already was.
 * @throws {Error} When the audit write fails.
 */
async function auditTimelineView(
  actor: Actor,
  kind: TimelineKind,
  id: string,
  input: TimelineQueryInput
): Promise<void> {
  const key = redisKey('timeline', 'audit', actor.userId, kind, id, input.view)
  let hasClaimedKey = false
  try {
    const redis = await getRedis()
    const reply = await redis.set(key, '1', {
      condition: 'NX',
      expiration: { type: 'EX', value: TIMELINE_AUDIT_THROTTLE_SECONDS },
    })
    if (reply === null) return
    hasClaimedKey = true
  } catch (error) {
    logger.warn('Timeline audit throttle unavailable; writing the audit entry anyway', { error })
  }
  try {
    const platform = await platformTenantOrThrow()
    await recordTimelineView(actor, platform.id, kind, id, {
      range: input.range,
      view: input.view,
    })
  } catch (error) {
    if (hasClaimedKey) await releaseThrottleKey(key)
    throw error
  }
}

/**
 * Delete a throttle key, logging rather than throwing on failure.
 * @param key - The key.
 * @returns Resolves once deleted or logged.
 */
async function releaseThrottleKey(key: string): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.del(key)
  } catch (error) {
    logger.warn('Could not release the timeline audit throttle key', { error })
  }
}

/**
 * A cached page, if one is there.
 * @param key - The cache key.
 * @returns The page, or undefined on a miss. A Redis or parse failure is a
 *   miss, logged at `warn`.
 */
async function readCachedPage(key: string): Promise<TimelinePage | undefined> {
  try {
    const redis = await getRedis()
    const cached = await redis.get(key)
    return cached === null ? undefined : (JSON.parse(cached) as TimelinePage)
  } catch (error) {
    logger.warn('Timeline cache read failed; asking PostHog', { error })
    return undefined
  }
}

/**
 * Keep a page for `TIMELINE_CACHE_TTL_SECONDS`.
 * @param key - The cache key.
 * @param page - The page.
 * @returns Resolves once written; a Redis failure is logged at `warn` and the page still returned.
 */
async function writeCachedPage(key: string, page: TimelinePage): Promise<void> {
  try {
    const redis = await getRedis()
    await redis.set(key, JSON.stringify(page), {
      expiration: { type: 'EX', value: TIMELINE_CACHE_TTL_SECONDS },
    })
  } catch (error) {
    logger.warn('Timeline cache write failed', { error })
  }
}

/**
 * The name a timeline shows for a user: first and last name, or the email
 * when neither is set.
 * @param user - The user's name fields.
 * @returns The display name.
 */
function displayNameOf(user: PlatformUserLabel): string {
  const name = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
  return name === '' ? user.email : name
}

/**
 * Attach each row's actor with one query over the page's distinct
 * non-system distinct ids.
 * @param rows - The page's rows.
 * @returns The rows with `actor`: null for a `system` row; `displayName`
 *   null when no user row has the id.
 */
async function withActors(rows: TimelineRow[]): Promise<TenantTimelineRow[]> {
  const ids = [
    ...new Set(rows.map((row) => row.distinctId).filter((id) => id !== SYSTEM_DISTINCT_ID)),
  ]
  const users = await platformUserRepository.listLabels(ids)
  const names = new Map(users.map((user) => [user.id, displayNameOf(user)]))
  return rows.map((row) => {
    const actor: TimelineActor | null =
      row.distinctId === SYSTEM_DISTINCT_ID
        ? null // eslint-disable-line unicorn/no-null -- the contract sends JSON null for a system row
        : // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for no user row
          { id: row.distinctId, displayName: names.get(row.distinctId) ?? null }
    return { ...row, actor }
  })
}

/**
 * The `tenant` group type's index, which a tenant query needs.
 * @returns The index.
 * @throws {TimelineUnavailableError} When PostHog fails or has no `tenant` group type.
 */
async function requireTenantGroupTypeIndex(): Promise<number> {
  const index = await tenantGroupTypeIndex()
  if (index === undefined) throw new TimelineUnavailableError()
  return index
}

/**
 * Ask PostHog for one page and map it.
 * @param kind - Whose timeline.
 * @param id - The user or tenant id.
 * @param input - The validated query.
 * @param cursor - The decoded cursor of a later page.
 * @returns The page.
 * @throws {TimelineUnavailableError} When the budget is spent, or PostHog
 *   fails, times out or answers in an unexpected shape (each logged).
 */
async function queryPage(
  kind: TimelineKind,
  id: string,
  input: TimelineQueryInput,
  cursor: TimelineCursor | undefined
): Promise<TimelinePage> {
  if ((await takeTimelineQueryBudget()) === 'exhausted') {
    logger.warn('Timeline query budget exhausted; not asking PostHog')
    throw new TimelineUnavailableError()
  }
  const groupTypeIndex = kind === 'tenant' ? await requireTenantGroupTypeIndex() : undefined
  const { query, values } = buildTimelineQuery(kind, {
    id,
    range: input.range,
    view: input.view,
    cursor,
    groupTypeIndex,
  })
  // PostHog otherwise answers a repeated query from its own cache for hours; ours is the 30 s one.
  const result = await posthogApi('POST', posthogProjectPath('query/'), {
    query: { kind: 'HogQLQuery', query, values },
    refresh: 'force_blocking',
  })
  if (result.kind !== 'ok') {
    logTimelineFailure(result, 'timeline query')
    throw new TimelineUnavailableError()
  }
  const results = (result.json as { results?: unknown } | undefined)?.results
  if (!Array.isArray(results)) {
    logger.error('PostHog answered a timeline query in an unexpected shape')
    throw new TimelineUnavailableError()
  }
  const rows = mapTimelineResults(results.slice(0, TIMELINE_PAGE_SIZE), { kind, id })
  // From raw row 100, before any drop or dedupe, so filtering never opens a gap or a repeat.
  const after =
    results.length > TIMELINE_PAGE_SIZE ? cursorAfter(results[TIMELINE_PAGE_SIZE - 1]) : undefined
  const nextCursor =
    after === undefined
      ? null // eslint-disable-line unicorn/no-null -- the contract sends JSON null on the last page
      : encodeTimelineCursor(after)
  return {
    configured: true,
    rows: kind === 'tenant' ? await withActors(rows) : rows,
    nextCursor,
    links: timelineLinks(
      groupTypeIndex === undefined ? { kind: 'user', id } : { kind: 'tenant', id, groupTypeIndex }
    ),
  }
}

/**
 * One timeline page, after the target has been found.
 * @param actor - The staff member asking.
 * @param kind - Whose timeline.
 * @param id - The user or tenant id.
 * @param input - The validated query.
 * @param cursor - The decoded cursor of a later page.
 * @returns The page, or `configured: false`.
 */
async function timelinePage(
  actor: Actor,
  kind: TimelineKind,
  id: string,
  input: TimelineQueryInput,
  cursor: TimelineCursor | undefined
): Promise<TimelinePage> {
  if (!isTimelineEnabled()) return { configured: false }
  await auditTimelineView(actor, kind, id, input)
  const key = cacheKey(kind, id, input)
  const cached = await readCachedPage(key)
  if (cached !== undefined) return cached
  const page = await queryPage(kind, id, input, cursor)
  await writeCachedPage(key, page)
  return page
}

/**
 * One page of a user's timeline: the events of their PostHog person, and
 * staff actions on them. A soft-deleted user still has one.
 * @param actor - The staff member asking (a platform admin; the route checked).
 * @param userId - The user's id.
 * @param input - The validated query.
 * @returns The page, or `configured: false` without a personal key.
 * @throws {HttpError} 400 for a malformed cursor; 404 when no user has the id.
 * @throws {TimelineUnavailableError} When PostHog cannot answer (502).
 */
export async function getUserTimeline(
  actor: Actor,
  userId: string,
  input: TimelineQueryInput
): Promise<TimelinePage> {
  const cursor = cursorOf(input.before)
  const user = await userRepository.findById(userId, { includeDeleted: true })
  if (!user) throw new HttpError('User not found', 404)
  return timelinePage(actor, 'user', userId, input, cursor)
}

/**
 * One page of a customer tenant's timeline: the events of its PostHog
 * group, and staff actions on it, each with its actor. An archived tenant
 * still has one; the platform tenant has none.
 * @param actor - The staff member asking (a platform admin; the route checked).
 * @param tenantId - The tenant's id.
 * @param input - The validated query.
 * @returns The page, or `configured: false` without a personal key.
 * @throws {HttpError} 400 for a malformed cursor; 404 when no customer tenant has the id.
 * @throws {TimelineUnavailableError} When PostHog cannot answer (502).
 */
export async function getTenantTimeline(
  actor: Actor,
  tenantId: string,
  input: TimelineQueryInput
): Promise<TimelinePage> {
  const cursor = cursorOf(input.before)
  const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (!tenant || tenant.isPlatform) throw new HttpError('Tenant not found', 404)
  return timelinePage(actor, 'tenant', tenantId, input, cursor)
}
