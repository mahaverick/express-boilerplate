/**
 * @file The staff Errors views behind `GET /platform/users/:id/errors` and
 * `GET /platform/tenants/:id/errors`: the PostHog error issues a user or a
 * tenant hit in the last 30 days. The routes check for platform admin
 * first. Each request runs in this order: the target looked up (404), the
 * configuration checked (`configured: false`, nothing audited, PostHog not
 * called), the view audited (throttled per staff member and target,
 * platform-view-audit.service.ts), the hourly timeline budget taken, and
 * only then PostHog asked, with the fixed query in errors-query.service.ts.
 * Nothing is cached. Each issue's most recent event is verified, and its
 * text re-scrubbed, by errors-mapper.service.ts.
 */
import { isTimelineEnabled, posthogAppHost } from '@/configs/analytics.config'
import { getEnv } from '@/configs/env.config'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { mapErrorIssues } from '@/services/analytics/errors-mapper.service'
import { buildErrorsQuery } from '@/services/analytics/errors-query.service'
import { posthogApi, posthogProjectPath } from '@/services/analytics/posthog-api.service'
import { takeTimelineQueryBudget } from '@/services/analytics/timeline-budget.service'
import { tenantGroupTypeIndex } from '@/services/analytics/timeline-group-index.service'
import { logTimelineFailure } from '@/services/analytics/timeline-query.service'
import { recordErrorsView } from '@/services/audit.service'
import { logger } from '@/services/logger.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { auditThrottledView } from '@/services/platform-view-audit.service'
import { redisKey } from '@/services/redis.service'
import type { Actor } from '@/types/actor'
import type { ErrorIssuesPage } from '@/types/error-issue'
import type { TimelineKind } from '@/types/timeline'

const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * The project's Error Tracking URL, which each issue's id is appended to.
 * @returns `{app}/project/{pid}/error_tracking`.
 * @throws {Error} When `POSTHOG_PROJECT_ID` is not set: only code that checked
 *   `isTimelineEnabled()` may build links.
 */
function issueLinkBase(): string {
  const projectId = getEnv().POSTHOG_PROJECT_ID
  if (projectId === undefined) throw new Error('POSTHOG_PROJECT_ID is not set')
  return `${posthogAppHost()}/project/${String(projectId)}/error_tracking`
}

/**
 * Ask PostHog for one target's error issues and map them.
 * @param kind - Whose errors.
 * @param id - The user or tenant id.
 * @returns The issues.
 * @throws {TimelineUnavailableError} When the budget is spent, the project has
 *   no `tenant` group type, or PostHog fails, times out or answers in an
 *   unexpected shape (each logged).
 */
async function queryIssues(kind: TimelineKind, id: string): Promise<ErrorIssuesPage> {
  if ((await takeTimelineQueryBudget()) === 'exhausted') {
    logger.warn('Timeline query budget exhausted; not asking PostHog for errors')
    throw new TimelineUnavailableError()
  }
  let groupTypeIndex: number | undefined
  if (kind === 'tenant') {
    groupTypeIndex = await tenantGroupTypeIndex()
    if (groupTypeIndex === undefined) throw new TimelineUnavailableError()
  }
  const { query, values } = buildErrorsQuery(kind, { id, groupTypeIndex })
  // PostHog otherwise answers a repeated query from its own cache for hours.
  const result = await posthogApi('POST', posthogProjectPath('query/'), {
    query: { kind: 'HogQLQuery', query, values },
    refresh: 'force_blocking',
  })
  if (result.kind !== 'ok') {
    logTimelineFailure(result, 'errors query')
    throw new TimelineUnavailableError()
  }
  const results = (result.json as { results?: unknown } | undefined)?.results
  if (!Array.isArray(results)) {
    logger.error('PostHog answered an errors query in an unexpected shape')
    throw new TimelineUnavailableError()
  }
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null: the list is never paged
  return { configured: true, items: mapErrorIssues(results, issueLinkBase()), nextCursor: null }
}

/**
 * One Errors view, after the target has been found.
 * @param actor - The staff member asking.
 * @param kind - Whose errors.
 * @param id - The user or tenant id.
 * @returns The issues, or `configured: false`.
 */
async function errorsView(actor: Actor, kind: TimelineKind, id: string): Promise<ErrorIssuesPage> {
  if (!isTimelineEnabled()) return { configured: false }
  await auditThrottledView({
    key: redisKey('errors', 'audit', actor.userId, kind, id),
    label: 'Errors view',
    kind,
    targetId: id,
    write: async () => {
      const platform = await platformTenantOrThrow()
      await recordErrorsView(actor, platform.id, kind, id)
    },
  })
  return queryIssues(kind, id)
}

/**
 * A user's error issues: the `$exception` events sent under their distinct
 * id, by the server for their requests or by their consented browser. A
 * soft-deleted user still has them.
 * @param actor - The staff member asking (a platform admin; the route checked).
 * @param userId - The user's id.
 * @returns The issues, or `configured: false` without the personal key or the project id.
 * @throws {HttpError} 404 when no user has the id.
 * @throws {TimelineUnavailableError} When PostHog cannot answer (502).
 */
export async function getUserErrors(actor: Actor, userId: string): Promise<ErrorIssuesPage> {
  const user = await userRepository.findById(userId, { includeDeleted: true })
  if (!user) throw new HttpError('User not found', 404)
  return errorsView(actor, 'user', userId)
}

/**
 * A customer tenant's error issues: the `$exception` events in its PostHog
 * group. An archived tenant still has them; the platform tenant has none.
 * @param actor - The staff member asking (a platform admin; the route checked).
 * @param tenantId - The tenant's id.
 * @returns The issues, or `configured: false` without the personal key or the project id.
 * @throws {HttpError} 404 when no customer tenant has the id.
 * @throws {TimelineUnavailableError} When PostHog cannot answer (502).
 */
export async function getTenantErrors(actor: Actor, tenantId: string): Promise<ErrorIssuesPage> {
  const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (!tenant || tenant.isPlatform) throw new HttpError('Tenant not found', 404)
  return errorsView(actor, 'tenant', tenantId)
}
