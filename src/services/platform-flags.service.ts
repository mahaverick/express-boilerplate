/**
 * @file The Apex flag inspector behind `GET /platform/flags` and
 * `GET /platform/flags/evaluate`. Both read this replica's in-memory
 * definitions snapshot and never call PostHog. The list joins the registry
 * with the snapshot; evaluate builds one user's (and optionally one
 * tenant's) traits from the database and runs every registered flag through
 * the live evaluator. Evaluate is the one place traits leave the server, so
 * it is audited as `user.flags_evaluated`, at most once per staff member,
 * user, tenant and app every `TIMELINE_AUDIT_THROTTLE_SECONDS`, before
 * anything is read.
 */
import { posthogFlagUrl } from '@/configs/analytics.config'
import { FLAG_TRAITS, FLAGS, type FlagEntry } from '@/constants/flags.constants'
import { HttpError } from '@/errors/http-error'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { recordFlagsEvaluateView } from '@/services/audit.service'
import { flagContextForUser } from '@/services/flags/flag-context.service'
import { getFlagsStatus } from '@/services/flags/flag-counters.service'
import { definitionOf, flagStateOf } from '@/services/flags/flag-evaluator.service'
import { getFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import { evaluateAll } from '@/services/flags/flags.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { auditThrottledView } from '@/services/platform-view-audit.service'
import { redisKey } from '@/services/redis.service'
import type { Actor } from '@/types/actor'
import type {
  FlagRow,
  FlagsEvaluateResponse,
  FlagsListResponse,
  UnregisteredRow,
} from '@/types/flags'
import type { ParsedDefinition } from '@/validators/flag-definition.validators'
import type { PlatformFlagsEvaluateQuery } from '@/validators/platform.validators'

const userRepository = new UserRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * The highest rollout of any condition, a null rollout counting as 100.
 * @param definition - The flag's parsed definition, if PostHog has it.
 * @returns The percentage, or null when there is no condition to read (a
 *   missing flag, or a malformed one, whose `raw` is null).
 */
function maxRolloutOf(definition: ParsedDefinition | undefined): number | null {
  const groups = definition?.raw?.filters.groups ?? []
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null when there is no condition
  if (groups.length === 0) return null
  return Math.max(...groups.map((group) => group.rollout_percentage ?? 100))
}

/**
 * One registered flag's row.
 * @param entry - The registry entry.
 * @param definition - Its parsed definition, if PostHog has it.
 * @returns The row.
 */
function flagRow(entry: FlagEntry, definition: ParsedDefinition | undefined): FlagRow {
  const state = flagStateOf(definition)
  return {
    key: entry.key,
    description: entry.description,
    kind: entry.kind,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for a boolean flag
    variants: entry.kind === 'multivariate' ? entry.variants : null,
    scope: entry.scope,
    client: entry.client,
    apps: entry.apps,
    experiment: entry.experiment,
    fallback: entry.fallback,
    state,
    ...(state === 'unsupported' &&
      typeof definition?.unsupported === 'string' && {
        unsupportedReason: definition.unsupported,
      }),
    conditions: definition?.raw?.filters.groups.length ?? 0,
    maxRollout: maxRolloutOf(definition),
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null for a flag PostHog lacks
    posthogUrl: definition === undefined ? null : posthogFlagUrl(definition.id),
  }
}

/**
 * The inspector's list: every registered flag with its live state, the
 * flags PostHog has that the registry lacks, the traits reference and the
 * snapshot's age.
 * @returns The list; never calls PostHog.
 */
export async function listFlags(): Promise<FlagsListResponse> {
  const snapshot = getFlagSnapshot()
  const definitions = snapshot?.flags ?? {}
  const registered = new Set<string>(FLAGS.map((entry) => entry.key))
  const unregistered: UnregisteredRow[] = Object.values(definitions)
    .filter((definition) => !registered.has(definition.key))
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map((definition) => ({
      key: definition.key,
      active: definition.active,
      posthogUrl: posthogFlagUrl(definition.id),
    }))
  const status = await getFlagsStatus()
  return {
    items: FLAGS.map((entry) =>
      flagRow(entry, snapshot === null ? undefined : definitionOf(snapshot, entry.key))
    ),
    unregistered,
    traits: FLAG_TRAITS.map((trait) => ({ ...trait })),
    snapshot: { enabled: status.enabled, fetchedAt: status.snapshotAt, stale: status.stale },
  }
}

/**
 * The throttle key's tenant part for an evaluation with no tenant. The query
 * takes a tenant id only as a UUID, so no tenant's part can equal it.
 */
const NO_TENANT = 'none'

/**
 * Audit an evaluate view, at most once per staff member, user, tenant (or
 * none) and app every `TIMELINE_AUDIT_THROTTLE_SECONDS`
 * (platform-view-audit.service.ts): the entry records the tenant and the
 * app, so each combination of them is audited on its own.
 * @param actor - The staff member.
 * @param query - The validated query; the entry records its tenant and app.
 * @returns Resolves once written, or once the throttle said it already was.
 * @throws {Error} When the audit write fails.
 */
async function auditEvaluateView(actor: Actor, query: PlatformFlagsEvaluateQuery): Promise<void> {
  await auditThrottledView({
    key: redisKey(
      'flags',
      'audit',
      actor.userId,
      'user',
      query.userId,
      'tenant',
      query.tenantId ?? NO_TENANT,
      'app',
      query.app
    ),
    label: 'Flags evaluate view',
    kind: 'user',
    targetId: query.userId,
    write: async () => {
      const platform = await platformTenantOrThrow()
      await recordFlagsEvaluateView(actor, platform.id, query.userId, {
        // eslint-disable-next-line unicorn/no-null -- the audit metadata records "no tenant" as null
        tenantId: query.tenantId ?? null,
        clientApp: query.app,
      })
    },
  })
}

/**
 * Evaluate every registered flag for one user, and optionally one of their
 * tenants, as the app's client would be served it, with each reason.
 * @param actor - The staff member asking (a platform admin; the route checked).
 * @param query - The validated query.
 * @returns The traits used, every flag's evaluation and the snapshot's age.
 * @throws {HttpError} 404 when no live user has the id; 400 when `tenantId`
 *   comes with `app=apex` (staff are evaluated with no tenant) or names a
 *   tenant the user is not a member of.
 */
export async function evaluateFlagsFor(
  actor: Actor,
  query: PlatformFlagsEvaluateQuery
): Promise<FlagsEvaluateResponse> {
  const user = await userRepository.findById(query.userId)
  if (!user) throw new HttpError('User not found', 404)
  if (query.tenantId !== undefined && query.app === 'apex') {
    throw new HttpError('Validation failed', 400, undefined, {
      tenantId: ['apex flags are evaluated with no tenant.'],
    })
  }
  if (query.tenantId !== undefined) {
    const membership = await userMembershipRepository.findByUserAndTenant(
      query.userId,
      query.tenantId
    )
    if (!membership) {
      throw new HttpError('Validation failed', 400, undefined, {
        tenantId: ['The user is not a member of this tenant.'],
      })
    }
  }
  await auditEvaluateView(actor, query)
  // eslint-disable-next-line unicorn/no-null -- no tenant, and no session: this is not the user's own request
  const context = await flagContextForUser(query.userId, query.tenantId ?? null, null)
  const evaluations = await evaluateAll(context)
  const status = await getFlagsStatus()
  return {
    traits: { ...context.personProps, ...context.groupProps.tenant },
    flags: evaluations.map(({ key, evaluation }) => ({ key, ...evaluation })),
    snapshot: { fetchedAt: status.snapshotAt, stale: status.stale },
  }
}
