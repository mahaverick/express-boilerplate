/**
 * @file Every whitelisted sort is served by an index: the helper's own page
 * query, EXPLAINed with sequential scans off, names the expected index in
 * its main plan tree, and no line of that tree is a Sort or Incremental
 * Sort (so none hides under the Limit or below a join).
 * SubPlan and InitPlan blocks (a member count, a platform-role lookup) are
 * left out, since a Sort inside one does not order the page. Where a sibling index on the same leading columns could
 * serve the order with an Incremental Sort on the id (a partial unique
 * index, a single-column index), it is dropped inside the transaction,
 * which then rolls back, so the named index must serve the order alone.
 * Three kinds of list are bounded rather than ordered by an index, and
 * their check says so: member name/email and my-tenants name sort on a
 * joined row, so the check asserts the membership rows come from a
 * `tenant_id`- or `user_id`-leading index with that column in its
 * `Index Cond` (one tenant's members, one user's memberships); onboarding
 * sorts on the progress query's computed timestamps, so the check asserts
 * the tenants are read through an index and never sequentially. Search runs
 * through GIN trigram indexes, checked with every scan but a bitmap one off.
 */
import { describe, expect, it } from 'vitest'
import { auditLogList } from '@/repositories/audit-log.repository'
import { notificationList } from '@/repositories/notification.repository'
import {
  platformEmailList,
  platformSuppressionList,
} from '@/repositories/platform-email.repository'
import { onboardingTenantList } from '@/repositories/platform-onboarding.repository'
import { platformTenantList } from '@/repositories/platform-tenant.repository'
import { platformUserList } from '@/repositories/platform-user.repository'
import { invitationList } from '@/repositories/tenant-invitation.repository'
import { myTenantList } from '@/repositories/tenant.repository'
import { memberList } from '@/repositories/user-membership.repository'
import { db, sql } from '@/services/database.service'
import { bindScope, signCursor, type CursorKey } from '@/utilities/list-cursor.utilities'
import { listPageQuery, type ListParams } from '@/utilities/list-page.utilities'

const ID = '0199c4a2-0000-7000-8000-000000000001'

/**
 * Plan settings for an ordered case: sequential scans, bitmap scans and
 * explicit sorts are off, so on a table of any size the plan can only name
 * the index that hands the rows over in page order; a sort the index cannot
 * avoid still shows as a Sort in the main plan tree and fails the case.
 */
const ORDERED_OFF = [
  'enable_seqscan',
  'enable_bitmapscan',
  'enable_sort',
  'enable_incremental_sort',
] as const

/**
 * The membership indexes led by the user, dropped from a tenant-led bounded case so the planner cannot pick one on a table of unrepresentative size.
 */
const USER_LED_MEMBERSHIP_INDEXES = [
  'user_memberships_user_id_tenant_id_unique',
  'user_memberships_user_joined_sort_idx',
] as const

/**
 * The membership indexes led by the tenant, dropped from a user-led bounded case for the same reason.
 */
const TENANT_LED_MEMBERSHIP_INDEXES = [
  'user_memberships_tenant_role_sort_idx',
  'user_memberships_tenant_joined_sort_idx',
] as const

/**
 * The indexes that order users and tenants for their own lists. A bounded
 * case drops them, so a members or my-tenants plan cannot start from an
 * ordered walk of every user or tenant and join the memberships per row.
 */
const JOINED_ORDER_INDEXES = [
  'users_email_sort_idx',
  'users_email_unique',
  'users_created_sort_idx',
  'users_last_logged_in_sort_idx',
  'tenants_name_sort_idx',
  'tenants_created_sort_idx',
] as const

/**
 * Thrown to roll back the planning transaction, carrying the plan out of it.
 */
class RollbackAfterPlan extends Error {
  constructor(readonly plan: string) {
    super('rollback after plan')
  }
}

/**
 * The text plan for a query with its parameters, with the given scans off
 * and the `hidden` indexes dropped; the transaction always rolls back.
 */
async function planFor(
  query: { sql: string; params: unknown[] },
  options: { hidden?: readonly string[]; off?: readonly string[] } = {}
): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      const settings = options.off ?? ['enable_seqscan']
      for (const setting of settings) {
        await tx.unsafe(`set local ${setting} = off`)
      }
      const hidden = options.hidden ?? []
      for (const index of hidden) await tx.unsafe(`drop index "${index}"`)
      const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(
        `explain ${query.sql}`,
        query.params as Parameters<typeof tx.unsafe>[1]
      )
      throw new RollbackAfterPlan(rows.map((row) => row['QUERY PLAN']).join('\n'))
    })
  } catch (error) {
    if (error instanceof RollbackAfterPlan) return error.plan
    throw error
  }
  throw new Error('the plan transaction committed')
}

/**
 * The plan's main tree: every line but those inside a SubPlan or InitPlan
 * block (the block's label and every line indented deeper than it).
 */
function mainTree(plan: string): string[] {
  const kept: string[] = []
  let blockDepth: number | undefined
  for (const line of plan.split('\n')) {
    const depth = line.length - line.trimStart().length
    if (blockDepth !== undefined && depth > blockDepth) continue
    blockDepth = undefined
    if (/^(->\s+)?(SubPlan|InitPlan)\b/.test(line.trimStart())) {
      blockDepth = depth
      continue
    }
    kept.push(line)
  }
  return kept
}

/**
 * The node directly under the plan's top `Limit`: the one that hands the rows over in page order.
 */
function orderingNode(lines: readonly string[]): string {
  if (!/^Limit\b/.test(lines[0] ?? ''))
    throw new Error(`the plan does not start with Limit:\n${lines.join('\n')}`)
  const node = lines.slice(1).find((line) => line.trimStart().startsWith('->'))
  if (node === undefined) throw new Error(`no node under Limit:\n${lines.join('\n')}`)
  return node.trim()
}

/**
 * First-page params for one sort: no search, no cursor.
 */
function first(sort: string): ListParams {
  return {
    search: undefined,
    sort,
    cursor: undefined,
    direction: 'next',
    limit: 20,
    total: false,
    scope: 'explain',
  }
}

/**
 * Params for the page after a boundary row: a cursor signed under the list's own scope, carrying the boundary's sort value then its id.
 */
function after(
  list: { bound?: Readonly<Record<string, string>> | undefined },
  sort: string,
  keys: readonly CursorKey[]
): ListParams {
  const base = first(sort)
  const scope = list.bound === undefined ? base.scope : bindScope(base.scope, list.bound)
  return { ...base, cursor: signCursor(sort, scope, keys) }
}

const live = { state: ['active' as const, 'suspended' as const] }
const liveUsers = {
  status: ['active' as const, 'inactive' as const],
  verified: undefined,
  staff: undefined,
}
const noRoles = { roles: undefined }

/**
 * One ordered-by-index case: the page query, the index that must serve it, and its competitors.
 */
type OrderedCase = [
  name: string,
  query: () => { sql: string; params: unknown[] },
  index: string,
  hidden?: string[],
]

const ordered: OrderedCase[] = [
  [
    'tenants name',
    () => listPageQuery(db, platformTenantList(undefined, live), first('name')).toSQL(),
    'tenants_name_sort_idx',
  ],
  [
    'tenants created',
    () => listPageQuery(db, platformTenantList(undefined, live), first('created')).toSQL(),
    'tenants_created_sort_idx',
  ],
  [
    'tenants -created',
    () => listPageQuery(db, platformTenantList(undefined, live), first('-created')).toSQL(),
    'tenants_created_sort_idx',
  ],
  [
    'users email',
    () => listPageQuery(db, platformUserList(undefined, liveUsers), first('email')).toSQL(),
    'users_email_sort_idx',
    ['users_email_unique'],
  ],
  // Full, not partial, so soft-deleted users list in order too.
  [
    'deleted users email',
    () =>
      listPageQuery(
        db,
        platformUserList(undefined, { ...liveUsers, status: ['deleted'] }),
        first('email')
      ).toSQL(),
    'users_email_sort_idx',
  ],
  [
    'users created',
    () => listPageQuery(db, platformUserList(undefined, liveUsers), first('created')).toSQL(),
    'users_created_sort_idx',
  ],
  [
    'users -created',
    () => listPageQuery(db, platformUserList(undefined, liveUsers), first('-created')).toSQL(),
    'users_created_sort_idx',
  ],
  [
    'users -lastSignIn',
    () => listPageQuery(db, platformUserList(undefined, liveUsers), first('-lastSignIn')).toSQL(),
    'users_last_logged_in_sort_idx',
  ],
  [
    'emails -created',
    () => listPageQuery(db, platformEmailList(undefined, {}), first('-created')).toSQL(),
    'email_messages_created_sort_idx',
  ],
  [
    'emails created',
    () => listPageQuery(db, platformEmailList(undefined, {}), first('created')).toSQL(),
    'email_messages_created_sort_idx',
  ],
  [
    'suppressions -created',
    () =>
      listPageQuery(
        db,
        platformSuppressionList(undefined, { states: ['active'] }),
        first('-created')
      ).toSQL(),
    'email_suppressions_created_sort_idx',
  ],
  [
    'suppressions created',
    () =>
      listPageQuery(
        db,
        platformSuppressionList(undefined, { states: ['active'] }),
        first('created')
      ).toSQL(),
    'email_suppressions_created_sort_idx',
  ],
  [
    'suppressions address',
    () =>
      listPageQuery(
        db,
        platformSuppressionList(undefined, { states: ['active'] }),
        first('address')
      ).toSQL(),
    'email_suppressions_address_sort_idx',
    ['email_suppressions_active_address_unique'],
  ],
  [
    'platform audit -occurred',
    () =>
      listPageQuery(db, auditLogList(undefined, { scope: 'platform' }), first('-occurred')).toSQL(),
    'audit_logs_occurred_idx',
  ],
  [
    'platform audit occurred',
    () =>
      listPageQuery(db, auditLogList(undefined, { scope: 'platform' }), first('occurred')).toSQL(),
    'audit_logs_occurred_idx',
  ],
  [
    'tenant audit -occurred',
    () =>
      listPageQuery(
        db,
        auditLogList(undefined, { scope: 'tenant', tenantId: ID }),
        first('-occurred')
      ).toSQL(),
    'audit_logs_tenant_occurred_idx',
  ],
  [
    'tenant audit occurred',
    () =>
      listPageQuery(
        db,
        auditLogList(undefined, { scope: 'tenant', tenantId: ID }),
        first('occurred')
      ).toSQL(),
    'audit_logs_tenant_occurred_idx',
  ],
  [
    'members role',
    () => listPageQuery(db, memberList(ID, undefined, noRoles), first('role')).toSQL(),
    'user_memberships_tenant_role_sort_idx',
  ],
  [
    'members -joined',
    () => listPageQuery(db, memberList(ID, undefined, noRoles), first('-joined')).toSQL(),
    'user_memberships_tenant_joined_sort_idx',
  ],
  [
    'invitations -created',
    () => listPageQuery(db, invitationList(ID, undefined, noRoles), first('-created')).toSQL(),
    'tenant_invitations_tenant_created_sort_idx',
  ],
  [
    'invitations email',
    () => listPageQuery(db, invitationList(ID, undefined, noRoles), first('email')).toSQL(),
    'tenant_invitations_tenant_email_sort_idx',
    ['tenant_invitations_pending_unique'],
  ],
  [
    'my tenants -joined',
    () => listPageQuery(db, myTenantList(ID, undefined, noRoles), first('-joined')).toSQL(),
    'user_memberships_user_joined_sort_idx',
    ['user_memberships_user_id_tenant_id_unique'],
  ],
  [
    'notifications -created',
    () =>
      listPageQuery(
        db,
        notificationList(ID, undefined, { unread: undefined }),
        first('-created')
      ).toSQL(),
    'notifications_user_created_idx',
  ],
]

const AT = '2026-01-01T00:00:00.000000Z'

/**
 * Cases that plan with a cursor, one per seek shape: a timestamp, a text key, the role rank and the never-signed-in timestamp.
 */
const seeking: OrderedCase[] = [
  [
    'users -created after a cursor',
    () => {
      const list = platformUserList(undefined, liveUsers)
      return listPageQuery(db, list, after(list, '-created', [AT, ID])).toSQL()
    },
    'users_created_sort_idx',
  ],
  [
    'users email after a cursor',
    () => {
      const list = platformUserList(undefined, liveUsers)
      return listPageQuery(db, list, after(list, 'email', ['a@example.test', ID])).toSQL()
    },
    'users_email_sort_idx',
    ['users_email_unique'],
  ],
  [
    'users -lastSignIn after a cursor',
    () => {
      const list = platformUserList(undefined, liveUsers)
      return listPageQuery(db, list, after(list, '-lastSignIn', [AT, ID])).toSQL()
    },
    'users_last_logged_in_sort_idx',
  ],
  [
    'members role after a cursor',
    () => {
      const list = memberList(ID, undefined, noRoles)
      return listPageQuery(db, list, after(list, 'role', [2, ID])).toSQL()
    },
    'user_memberships_tenant_role_sort_idx',
  ],
]

/**
 * One bounded case: the page query, which column leads the membership index it must use, and competitors to drop.
 */
type BoundedCase = [
  name: string,
  query: () => { sql: string; params: unknown[] },
  owner: 'tenant' | 'user',
  hidden?: string[],
]

const bounded: BoundedCase[] = [
  [
    'members name',
    () => listPageQuery(db, memberList(ID, undefined, noRoles), first('name')).toSQL(),
    'tenant',
  ],
  [
    'members email',
    () => listPageQuery(db, memberList(ID, undefined, noRoles), first('email')).toSQL(),
    'tenant',
  ],
  [
    'my tenants name',
    () => listPageQuery(db, myTenantList(ID, undefined, noRoles), first('name')).toSQL(),
    'user',
  ],
]

describe('list sort indexes', () => {
  it.each([...ordered, ...seeking])(
    '%s is ordered by its index, with no Sort under the Limit',
    async (_name, query, index, hidden) => {
      const lines = mainTree(await planFor(query(), { hidden: hidden ?? [], off: ORDERED_OFF }))
      expect(orderingNode(lines)).not.toMatch(/^->\s+(Incremental )?Sort\b/)
      // Nor a Sort anywhere else in the main tree, such as below a join.
      expect(
        lines.filter((line) => /(^|->\s+)(Incremental )?Sort\b/.test(line.trimStart()))
      ).toEqual([])
      expect(lines.join('\n')).toContain(index)
    }
  )

  // The seek is a row comparison the index can bound, so it reads as an Index Cond on the expected index, never only a Filter.
  it.each(seeking)(
    '%s puts the seek in the index condition',
    async (_name, query, index, hidden) => {
      const lines = mainTree(await planFor(query(), { hidden: hidden ?? [], off: ORDERED_OFF }))
      const scan = lines.findIndex((line) => line.includes(`using ${index} `))
      expect(scan).toBeGreaterThanOrEqual(0)
      expect(lines[scan + 1]).toMatch(/Index Cond: .*ROW\(.*\bid\b/)
    }
  )

  // Bounded, not ordered: the sort reads a joined row, so it sorts one tenant's members or one user's memberships, found through an index led by that tenant or user.
  it.each(bounded)(
    '%s finds its memberships through its tenant- or user-led index',
    async (_name, query, owner, hidden) => {
      const rivals =
        owner === 'tenant' ? USER_LED_MEMBERSHIP_INDEXES : TENANT_LED_MEMBERSHIP_INDEXES
      const lines = mainTree(
        await planFor(query(), { hidden: [...rivals, ...JOINED_ORDER_INDEXES, ...(hidden ?? [])] })
      )
      // The first scan is the outer side of the join: the memberships, read through the owner's index with the owner in its Index Cond.
      const scan = lines.findIndex((line) =>
        /Index (Only )?Scan|Bitmap Index Scan|Seq Scan/.test(line)
      )
      expect(lines[scan]).toMatch(
        new RegExp(
          String.raw`(Index (Only )?Scan( Backward)? using|Bitmap Index Scan on) user_memberships_${owner}_\w+`
        )
      )
      expect(lines[scan + 1]).toMatch(
        new RegExp(String.raw`Index Cond: \(.*\b${owner}_id\)?(::text)? = `)
      )
      expect(lines.join('\n')).not.toMatch(/Seq Scan on user_memberships/)
    }
  )

  // Bounded by the tracked tenants: the progress query computes the sort timestamps per tenant, so no index can order them; the tenants are still read through an index.
  it.each(['progress', '-started', 'name'])(
    'onboarding %s reads the tenants through an index',
    async (sort) => {
      const filters = {
        state: 'stuck' as const,
        stuckBefore: new Date('2026-01-01T00:00:00.000Z'),
        keys: { tenantKeys: ['a'], memberKeys: ['b'], requiredKeys: ['a'] },
      }
      const plan = await planFor(
        listPageQuery(db, onboardingTenantList(undefined, filters), first(sort)).toSQL()
      )
      expect(plan).toMatch(/^Limit\b/)
      expect(plan).toMatch(
        /(Index (Only )?Scan( Backward)? using \w+|Bitmap Heap Scan) on tenants\b/
      )
      expect(plan).not.toMatch(/Seq Scan on tenants\b/)
    }
  )
})

describe('list search indexes', () => {
  it.each([
    ['tenants_name_trgm_idx', `select id from tenants where lower(name) like '%abc%'`],
    ['tenants_slug_trgm_idx', `select id from tenants where slug like '%abc%'`],
    ['users_email_trgm_idx', `select id from users where lower(email) like '%abc%'`],
    ['users_first_name_trgm_idx', `select id from users where lower(first_name) like '%abc%'`],
    ['users_last_name_trgm_idx', `select id from users where lower(last_name) like '%abc%'`],
    [
      'email_messages_recipient_trgm_idx',
      `select id from email_messages where lower(recipient) like '%abc%'`,
    ],
    [
      'email_suppressions_address_trgm_idx',
      `select id from email_suppressions where address like '%abc%'`,
    ],
  ])('%s serves a substring search', async (index, query) => {
    const plan = await planFor(
      { sql: query, params: [] },
      { off: ['enable_seqscan', 'enable_indexscan', 'enable_indexonlyscan'] }
    )
    expect(plan).toContain(index)
  })
})

describe('migration 0026: the tenant trigram indexes', () => {
  it('cover archived tenants too, with no predicate', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where tablename = 'tenants' and indexname in ('tenants_name_trgm_idx', 'tenants_slug_trgm_idx')
      order by indexname
    `
    expect(indexes).toHaveLength(2)
    for (const index of indexes) expect(index.indexdef).not.toContain('WHERE')
  })
})
