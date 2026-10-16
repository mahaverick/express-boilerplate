/**
 * @file The shared list contract (tests/helpers/list-contract.ts) over every
 * database-backed list endpoint. Each block isolates its rows with a
 * per-file tag or a fresh tenant or user, so other files' rows in this
 * worker's database never change a count.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { MEMBERSHIP_ROLES } from '@/constants/tenant.constants'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { describeListContract } from '../../helpers/list-contract'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * A short tag unique to this file's run, carried by every seeded name.
 */
const tag = `lc${randomUUID().slice(0, 8)}`

// eslint-disable-next-line unicorn/no-null -- SQL NULL for a seeded nullable column
const NONE = null

/**
 * A row index as four digits, so names sort and search predictably.
 * @param index - The row index.
 * @returns The index, zero-padded.
 */
function pad(index: number): string {
  return String(index).padStart(4, '0')
}

/**
 * The name of tenant row `index`: row 4 carries LIKE's wildcards, so a literal
 * search can be told from a pattern; row 1 repeats row 0's name, a tie on the
 * sort key.
 * @param index - The row index.
 * @returns The tenant name.
 */
function tenantName(index: number): string {
  if (index === 4) return `${tag}-t000_ 50%\\`
  return `${tag}-t${pad(index === 1 ? 0 : index)}`
}

/**
 * The email of user row `index`.
 * @param index - The row index.
 * @returns The address.
 */
function userEmail(index: number): string {
  return `${tag}-u${pad(index)}@example.test`
}

/**
 * LIKE patterns for the rows each block inserts.
 */
const like = {
  tenants: `${tag}-t%`,
  percentTenants: `${tag}-p%`,
  users: `${tag}-u%`,
  signInUsers: `${tag}-n%`,
  future: `${tag}-f%`,
  emails: `${tag}-e%`,
  suppressions: `${tag}-s%`,
  onboarding: `${tag}-o%`,
  members: `${tag}-m%`,
  myTenants: `${tag}-y%`,
}

/**
 * A creation time for row `index`: rows 2k and 2k+1 share a day, so the
 * seed has distinct values and ties.
 * @param index - The row index.
 * @returns The instant as ISO text (the driver binds text to a timestamp column).
 */
function createdAtOf(index: number): string {
  return new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 2))).toISOString()
}

/**
 * The bearer token of the staff admin each block creates in `setup`.
 */
const staff = { token: '' }

/**
 * Create the staff admin whose token reads the platform lists.
 */
async function createStaff(): Promise<void> {
  const admin = await createTrackedStaff('admin')
  staff.token = admin.token
}

/**
 * Remove the staff and every tracked user, audit rows first (their foreign keys are RESTRICT).
 */
async function removeStaff(): Promise<void> {
  await truncateAuditLogs()
  await deleteTrackedUsers()
}

/**
 * The time an item of the list was created, as a number.
 * @param item - A list item.
 * @returns Epoch milliseconds.
 */
function createdOf(item: unknown): number {
  return Date.parse((item as { createdAt: string }).createdAt)
}

describeListContract({
  name: 'GET /api/v1/platform/tenants',
  app: () => app,
  path: () => '/api/v1/platform/tenants',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  isolate: () => ({ search: `${tag}-t` }),
  sorts: ['name', 'created', '-created'],
  order: {
    name: (item) => (item as { name: string }).name.toLowerCase(),
    created: createdOf,
    '-created': createdOf,
  },
  setup: createStaff,
  teardown: removeStaff,
  seed: async (count) => {
    const rows = Array.from({ length: count }, (_unused, index) => ({
      name: tenantName(index),
      slug: `${tag}-t${pad(index)}`,
      lifecycle_state: index === 3 ? 'suspended' : 'active',
      created_at: createdAtOf(index),
    }))
    await sql`insert into tenants ${sql(rows, 'name', 'slug', 'lifecycle_state', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from tenants where slug like ${like.tenants}`
  },
  // `000_` matches row 4 only when `_` is literal; as a wildcard it would match rows 0–4.
  search: { text: `${tag}-t000_`, count: 1 },
  filters: [
    { query: { state: 'suspended' }, count: 1 },
    { query: { state: 'suspended,active' }, count: 5 },
    { query: { state: 'archived' }, count: 0 },
  ],
})

describe('GET /api/v1/platform/tenants search', () => {
  beforeAll(createStaff)
  afterAll(removeStaff)

  it('matches % literally', async () => {
    const percent = `${tag}-p 50%`
    const lookalike = `${tag}-p 501`
    const slugs = [`${tag}-p0`, `${tag}-p1`]
    await sql`insert into tenants (name, slug) values (${percent}, ${slugs[0] ?? ''}), (${lookalike}, ${slugs[1] ?? ''})`
    const response = await request(app)
      .get('/api/v1/platform/tenants')
      .query({ search: percent })
      .set('Authorization', `Bearer ${staff.token}`)
    expect(response.status).toBe(200)
    expect(
      (response.body as { data: { items: { name: string }[] } }).data.items.map((item) => item.name)
    ).toEqual([percent])
    await sql`delete from tenants where slug like ${like.percentTenants}`
  })
})

describeListContract({
  name: 'GET /api/v1/platform/users',
  app: () => app,
  path: () => '/api/v1/platform/users',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  isolate: () => ({ search: `${tag}-u` }),
  sorts: ['email', 'created', '-created', '-lastSignIn'],
  order: {
    email: (item) => (item as { email: string }).email.toLowerCase(),
    created: createdOf,
    '-created': createdOf,
    // A user who never signed in sorts below every signed-in one.
    '-lastSignIn': (item) => {
      const signedIn = (item as { lastLoggedInAt: string | null }).lastLoggedInAt
      return signedIn === NONE ? -Infinity : Date.parse(signedIn)
    },
  },
  // Emails are unique, so the email sort has no tie to test.
  uniqueKeys: ['email'],
  setup: createStaff,
  teardown: removeStaff,
  seed: async (count) => {
    const now = new Date().toISOString()
    const rows = Array.from({ length: count }, (_unused, index) => ({
      email: userEmail(index),
      first_name: index === 2 ? `${tag}-uAnn` : NONE,
      active: index !== 3,
      email_verified_at: index < 2 ? now : NONE,
      // Every other user has signed in, on distinct days; the rest never have.
      last_logged_in_at:
        index % 2 === 0 ? new Date(Date.UTC(2026, 0, 1 + index)).toISOString() : NONE,
      created_at: createdAtOf(index),
    }))
    await sql`insert into users ${sql(rows, 'email', 'first_name', 'active', 'email_verified_at', 'last_logged_in_at', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from users where email like ${like.users}`
  },
  search: { text: `${tag}-uann`, count: 1 },
  filters: [
    { query: { status: 'inactive' }, count: 1 },
    { query: { status: 'inactive,active' }, count: 5 },
    { query: { status: 'deleted' }, count: 0 },
    { query: { verified: 'true' }, count: 2 },
    { query: { staff: 'false' }, count: 5 },
  ],
})

/**
 * The email of the sign-in-order block's user `suffix`.
 * @param suffix - The user's suffix.
 * @returns The address.
 */
function emailOf(suffix: string): string {
  return `${tag}-n${suffix}@example.test`
}

describe('GET /api/v1/platform/users sort=-lastSignIn', () => {
  beforeAll(createStaff)
  afterAll(async () => {
    await sql`delete from users where email like ${like.signInUsers}`
    await removeStaff()
  })

  it('lists the most recent sign-in first and never-signed-in users last, across pages of one', async () => {
    const rows = [
      { email: emailOf('0'), last_logged_in_at: new Date(Date.UTC(2026, 0, 2)).toISOString() },
      { email: emailOf('1'), last_logged_in_at: NONE },
      { email: emailOf('2'), last_logged_in_at: new Date(Date.UTC(2026, 0, 3)).toISOString() },
      { email: emailOf('3'), last_logged_in_at: NONE },
    ]
    await sql`insert into users ${sql(rows, 'email', 'last_logged_in_at')}`
    const emails: string[] = []
    let cursor: string | null | undefined
    do {
      const response = await request(app)
        .get('/api/v1/platform/users')
        .query({
          search: `${tag}-n`,
          sort: '-lastSignIn',
          limit: '1',
          ...(typeof cursor === 'string' && { cursor }),
        })
        .set('Authorization', `Bearer ${staff.token}`)
      const page = (
        response.body as {
          data: { items: { email: string }[]; page: { nextCursor: string | null } }
        }
      ).data
      emails.push(...page.items.map((item) => item.email))
      cursor = page.page.nextCursor
    } while (typeof cursor === 'string')
    expect(emails.slice(0, 2)).toEqual([emailOf('2'), emailOf('0')])
    expect(emails.slice(2).toSorted((a, b) => a.localeCompare(b))).toEqual([
      emailOf('1'),
      emailOf('3'),
    ])
  })
})

/**
 * The creation time of future row `index`: 2099, newer than anything else in the worker's database.
 * @param index - The row index.
 * @returns The instant as ISO text.
 */
function futureAt(index: number): string {
  return new Date(Date.UTC(2099, 0, 1 + index)).toISOString()
}

/**
 * Insert one tenant per slug, oldest first, in 2099.
 * @param slugs - The slugs, also used as names.
 */
async function insertFutureTenants(slugs: readonly string[]): Promise<void> {
  const rows = slugs.map((slug, index) => ({ name: slug, slug, created_at: futureAt(index) }))
  await sql`insert into tenants ${sql(rows, 'name', 'slug', 'created_at')}`
}

/**
 * Insert one user per email, oldest first, in 2099.
 * @param emails - The addresses.
 */
async function insertFutureUsers(emails: readonly string[]): Promise<void> {
  const rows = emails.map((email, index) => ({ email, created_at: futureAt(index) }))
  await sql`insert into users ${sql(rows, 'email', 'created_at')}`
}

describe.each([
  {
    path: '/api/v1/platform/tenants',
    insert: insertFutureTenants,
    key: 'slug',
    values: [`${tag}-f0`, `${tag}-f1`, `${tag}-f2`],
    cleanup: () => sql`delete from tenants where slug like ${like.future}`,
  },
  {
    path: '/api/v1/platform/users',
    insert: insertFutureUsers,
    key: 'email',
    values: [`${tag}-f0@example.test`, `${tag}-f1@example.test`, `${tag}-f2@example.test`],
    cleanup: () => sql`delete from users where email like ${like.future}`,
  },
])('GET $path without search', ({ path, insert, key, values, cleanup }) => {
  beforeAll(async () => {
    await createStaff()
    await insert(values)
  })
  afterAll(async () => {
    await cleanup()
    await removeStaff()
  })

  it('lists the newest rows first under sort=-created, with a total when asked', async () => {
    const response = await request(app)
      .get(path)
      .query({ sort: '-created', limit: '3', total: '1' })
      .set('Authorization', `Bearer ${staff.token}`)
    expect(response.status).toBe(200)
    const data = (
      response.body as {
        data: { items: Record<string, string>[]; total: { count: number; capped: boolean } }
      }
    ).data
    expect(data.items.map((item) => item[key])).toEqual(values.toReversed())
    expect(data.total.count).toBeGreaterThanOrEqual(3)
  })

  it('lists in the default order, the seeded rows in ascending order wherever they fall', async () => {
    const response = await request(app)
      .get(path)
      .query({ limit: '100' })
      .set('Authorization', `Bearer ${staff.token}`)
    expect(response.status).toBe(200)
    const data = (response.body as { data: { items: Record<string, string>[] } }).data
    expect(data.items.length).toBeGreaterThan(0)
    const seeded = data.items.map((item) => item[key] ?? '').filter((name) => values.includes(name))
    expect(seeded).toEqual(values.slice(0, seeded.length))
  })
})

describeListContract({
  name: 'GET /api/v1/platform/emails',
  app: () => app,
  path: () => '/api/v1/platform/emails',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  isolate: () => ({ search: `${tag}-e` }),
  sorts: ['-created', 'created'],
  order: {
    '-created': createdOf,
    created: createdOf,
  },
  setup: createStaff,
  teardown: removeStaff,
  seed: async (count) => {
    const rows = Array.from({ length: count }, (_unused, index) => ({
      recipient: `${tag}-e${pad(index)}@example.test`,
      template_key: index % 2 === 1 ? 'password_reset' : 'account_setup',
      sender_class: 'transactional',
      message_id_header: `<${tag}-e${pad(index)}@example.test>`,
      status: index === 1 ? 'bounced' : 'sent',
      created_at: createdAtOf(index),
    }))
    await sql`insert into email_messages ${sql(rows, 'recipient', 'template_key', 'sender_class', 'message_id_header', 'status', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from email_messages where recipient like ${like.emails}`
  },
  search: { text: `${tag}-e0003`, count: 1 },
  filters: [
    { query: { status: 'bounced' }, count: 1 },
    { query: { status: 'sent,bounced' }, count: 5 },
    { query: { template: 'password_reset' }, count: 2 },
    { query: { template: 'password_reset,account_setup' }, count: 5 },
  ],
})

describeListContract({
  name: 'GET /api/v1/platform/email-suppressions',
  app: () => app,
  path: () => '/api/v1/platform/email-suppressions',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  // Both states, so all five seeded rows are visible; the default (active only) is pinned in platform-emails.test.ts.
  isolate: () => ({ search: `${tag}-s`, state: 'active,lifted' }),
  sorts: ['-created', 'created', 'address'],
  order: {
    '-created': createdOf,
    created: createdOf,
    address: (item) => (item as { address: string }).address,
  },
  // Addresses are unique, so the address sort has no tie to test.
  uniqueKeys: ['address'],
  setup: createStaff,
  teardown: removeStaff,
  seed: async (count) => {
    const now = new Date().toISOString()
    const rows = Array.from({ length: count }, (_unused, index) => ({
      address: `${tag}-s${pad(index)}@example.test`,
      reason: 'hard_bounce',
      lifted_at: index === 3 ? now : NONE,
      lift_reason: index === 3 ? 'Test lift' : NONE,
      created_at: createdAtOf(index),
    }))
    await sql`insert into email_suppressions ${sql(rows, 'address', 'reason', 'lifted_at', 'lift_reason', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from email_suppressions where address like ${like.suppressions}`
  },
  search: { text: `${tag}-s0002`, count: 1 },
  filters: [
    { query: { state: 'lifted' }, count: 1 },
    { query: { state: 'active' }, count: 4 },
  ],
})

/**
 * The instant an onboarding item's field names, as a number.
 * @param field - The item field holding an ISO instant.
 * @returns A key function over list items.
 */
function instantOf(field: 'lastProgressAt' | 'startedAt'): (item: unknown) => number {
  return (item) => Date.parse(String((item as Record<string, unknown>)[field]))
}

describeListContract({
  name: 'GET /api/v1/platform/onboarding/tenants',
  app: () => app,
  path: () => '/api/v1/platform/onboarding/tenants',
  headers: () => ({ Authorization: `Bearer ${staff.token}` }),
  isolate: () => ({ search: `${tag}-o`, state: 'stuck' }),
  sorts: ['progress', '-started', 'name'],
  order: {
    progress: instantOf('lastProgressAt'),
    '-started': instantOf('startedAt'),
    name: (item) => (item as { name: string }).name.toLowerCase(),
  },
  // Stuck is the default view, so the default sort is progress; any other state sorts by start.
  defaultSort: (filters) => (filters.state === 'stuck' ? 'progress' : '-started'),
  // Names are unique, so the name sort has no tie to test.
  uniqueKeys: ['name'],
  setup: createStaff,
  teardown: removeStaff,
  seed: async (count) => {
    // Weeks ago with no step done is stuck; rows 2k and 2k+1 share a start day, a tie.
    const now = Date.now()
    const rows = Array.from({ length: count }, (_unused, index) => ({
      name: `${tag}-o${pad(index)}`,
      slug: `${tag}-o${pad(index)}`,
      onboarding_tracked: true,
      onboarding_started_at: new Date(
        now - (30 + Math.floor(index / 2)) * 24 * 60 * 60 * 1000
      ).toISOString(),
    }))
    await sql`insert into tenants ${sql(rows, 'name', 'slug', 'onboarding_tracked', 'onboarding_started_at')}`
  },
  clear: async () => {
    await sql`delete from tenants where slug like ${like.onboarding}`
  },
  search: { text: `${tag}-o0001`, count: 1 },
  filters: [{ query: { state: 'awaiting_owner' }, count: 0 }],
})

/**
 * Five audit rows in one tenant: actions and access alternate, and rows 2k
 * and 2k+1 share an instant, so the seed has distinct times and ties.
 * @param tenantId - The tenant the rows are filed under.
 * @param count - How many rows.
 * @returns The rows to insert.
 */
function auditRows(tenantId: string, count: number) {
  const now = Date.now()
  return Array.from({ length: count }, (_unused, index) => ({
    tenant_id: tenantId,
    actor_kind: 'system',
    access: index % 2 === 1 ? 'platform' : 'member',
    action: index % 2 === 1 ? 'tenant.updated' : 'tenant.created',
    occurred_at: new Date(now - Math.floor(index / 2) * 60_000).toISOString(),
  }))
}

/**
 * The tenant each audit block files its rows under, with its owner.
 */
const audited = { tenantId: '', slug: '', ownerToken: '', otherSlug: '', otherToken: '' }

/**
 * Create the audited tenant, owned by a fresh user, and the staff admin.
 */
async function createAuditedTenant(): Promise<void> {
  await createStaff()
  const owner = await createTrackedUser()
  const tenant = await new TenantRepository().create({
    name: `${tag} audited`,
    slug: `${tag}-al-${randomUUID().slice(0, 6)}`,
    ownerId: owner.id,
  })
  const otherOwner = await createTrackedUser()
  const other = await new TenantRepository().create({
    name: `${tag} other audited`,
    slug: `${tag}-ao-${randomUUID().slice(0, 6)}`,
    ownerId: otherOwner.id,
  })
  Object.assign(audited, {
    tenantId: tenant.id,
    slug: tenant.slug,
    ownerToken: tokenFor(owner),
    otherSlug: other.slug,
    otherToken: tokenFor(otherOwner),
  })
}

/**
 * Remove the audit rows (truncate: the table refuses DELETE), the tenant and the users.
 */
async function removeAuditedTenant(): Promise<void> {
  await truncateAuditLogs()
  await sql`delete from tenants where slug in (${audited.slug}, ${audited.otherSlug})`
  await deleteTrackedUsers()
}

/**
 * The time an audit item occurred, as a number.
 * @param item - A list item.
 * @returns Epoch milliseconds.
 */
function occurredOf(item: unknown): number {
  return Date.parse((item as { occurredAt: string }).occurredAt)
}

for (const route of ['platform', 'tenant'] as const) {
  describeListContract({
    name:
      route === 'platform'
        ? 'GET /api/v1/platform/audit-log'
        : 'GET /api/v1/tenants/:slug/audit-log',
    app: () => app,
    path: () =>
      route === 'platform'
        ? '/api/v1/platform/audit-log'
        : `/api/v1/tenants/${audited.slug}/audit-log`,
    headers: () => ({
      Authorization: `Bearer ${route === 'platform' ? staff.token : audited.ownerToken}`,
    }),
    isolate: (): Record<string, string> =>
      route === 'platform' ? { tenant: audited.tenantId } : {},
    // The tenant route's rows depend on the path tenant, which is not a query param.
    ...(route === 'tenant' && {
      otherScope: {
        path: () => `/api/v1/tenants/${audited.otherSlug}/audit-log`,
        headers: () => ({ Authorization: `Bearer ${audited.otherToken}` }),
      },
    }),
    sorts: ['-occurred', 'occurred'],
    order: { '-occurred': occurredOf, occurred: occurredOf },
    setup: createAuditedTenant,
    teardown: removeAuditedTenant,
    seed: async (count) => {
      const rows = auditRows(audited.tenantId, count)
      await sql`insert into audit_logs ${sql(rows, 'tenant_id', 'actor_kind', 'access', 'action', 'occurred_at')}`
    },
    clear: truncateAuditLogs,
    search: { text: 'tenant.created', count: 3 },
    filters: [
      { query: { action: 'tenant.updated' }, count: 2 },
      { query: { action: 'tenant.updated,tenant.created' }, count: 5 },
      { query: { access: 'platform' }, count: 2 },
      { query: { access: 'member,platform' }, count: 5 },
    ],
  })
}

/**
 * The tenant each tenant-scoped block reads, its owner, and that owner's token,
 * with a second tenant the same owner owns, so a cursor replayed there can
 * only be refused for the tenant it is bound to.
 */
const owned = { tenantId: '', slug: '', ownerToken: '', ownerId: '', otherSlug: '' }

/**
 * Create a tenant owned by a fresh user (the owner's membership is the one
 * row seed() does not insert), and a second tenant with the same owner.
 */
async function createOwnedTenant(): Promise<void> {
  const owner = await createTrackedUser()
  const tenant = await new TenantRepository().create({
    name: `${tag} owned`,
    slug: `${tag}-ow-${randomUUID().slice(0, 6)}`,
    ownerId: owner.id,
  })
  const other = await new TenantRepository().create({
    name: `${tag} other owned`,
    slug: `${tag}-oo-${randomUUID().slice(0, 6)}`,
    ownerId: owner.id,
  })
  Object.assign(owned, {
    tenantId: tenant.id,
    slug: tenant.slug,
    ownerToken: tokenFor(owner),
    ownerId: owner.id,
    otherSlug: other.slug,
  })
}

/**
 * Remove both owned tenants (memberships and invitations cascade) and every tracked user.
 */
async function removeOwnedTenant(): Promise<void> {
  await truncateAuditLogs()
  await sql`delete from tenants where slug in (${owned.slug}, ${owned.otherSlug})`
  await deleteTrackedUsers()
}

/**
 * The roles seeded members and invitations take, by index.
 */
const SEEDED_ROLES = ['viewer', 'editor', 'admin', 'viewer', 'manager'] as const

/**
 * The instant of seeded row `index`, as UTC text: rows 2k and 2k+1 share an
 * instant, so the seed has distinct times and ties.
 * @param now - The one clock reading the whole seed is built from.
 * @param index - The row index.
 * @returns The ISO instant.
 */
function joinedAtOf(now: number, index: number): string {
  return new Date(now - Math.floor(index / 2) * 60_000).toISOString()
}

/**
 * The instant a member's membership, an invitation or a tenant row joined or was created, as a number.
 * @param field - The JSON path to the ISO instant.
 * @returns A key function over list items.
 */
function instantAt(field: (item: unknown) => string): (item: unknown) => number {
  return (item) => Date.parse(field(item))
}

describeListContract({
  name: 'GET /api/v1/tenants/:slug/members',
  app: () => app,
  path: () => `/api/v1/tenants/${owned.slug}/members`,
  headers: () => ({ Authorization: `Bearer ${owned.ownerToken}` }),
  isolate: () => ({}),
  // The rows depend on the path tenant, which is not a query param.
  otherScope: {
    path: () => `/api/v1/tenants/${owned.otherSlug}/members`,
    headers: () => ({ Authorization: `Bearer ${owned.ownerToken}` }),
  },
  sorts: ['name', 'email', 'role', '-joined'],
  order: {
    name: (item) => {
      const { user } = item as {
        user: { firstName: string | null; lastName: string | null; email: string }
      }
      const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
      return (full === '' ? user.email : full).toLowerCase()
    },
    // Addresses are unique, so the email sort has no tie to test.
    email: (item) => (item as { user: { email: string } }).user.email.toLowerCase(),
    role: (item) =>
      MEMBERSHIP_ROLES.indexOf(
        (item as { membership: { role: (typeof MEMBERSHIP_ROLES)[number] } }).membership.role
      ),
    '-joined': instantAt(
      (item) => (item as { membership: { createdAt: string } }).membership.createdAt
    ),
  },
  uniqueKeys: ['email'],
  setup: createOwnedTenant,
  teardown: removeOwnedTenant,
  seed: async (count) => {
    const now = Date.now()
    const users = await sql<{ id: string }[]>`insert into users ${sql(
      Array.from({ length: count }, (_unused, index) => ({
        email: `${tag}-m${pad(index)}@example.test`,
        // Rows 0 and 1 share a display name: a tie on the name sort.
        first_name: index < 2 ? `${tag}mira` : NONE,
      })),
      'email',
      'first_name'
    )} returning id`
    const memberships = users.map((user, index) => ({
      user_id: user.id,
      tenant_id: owned.tenantId,
      role: SEEDED_ROLES[index % SEEDED_ROLES.length],
      created_at: joinedAtOf(now, index),
    }))
    await sql`insert into user_memberships ${sql(memberships, 'user_id', 'tenant_id', 'role', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from users where email like ${like.members}`
  },
  idOf: (item) => (item as { membership: { id: string } }).membership.id,
  visible: 6,
  search: { text: `${tag}-m0003`, count: 1 },
  filters: [
    { query: { role: 'viewer' }, count: 2 },
    { query: { role: 'viewer,owner' }, count: 3 },
    { query: { role: 'admin' }, count: 1 },
  ],
})

describeListContract({
  name: 'GET /api/v1/tenants/:slug/invitations',
  app: () => app,
  path: () => `/api/v1/tenants/${owned.slug}/invitations`,
  headers: () => ({ Authorization: `Bearer ${owned.ownerToken}` }),
  isolate: () => ({}),
  otherScope: {
    path: () => `/api/v1/tenants/${owned.otherSlug}/invitations`,
    headers: () => ({ Authorization: `Bearer ${owned.ownerToken}` }),
  },
  sorts: ['-created', 'email'],
  order: {
    '-created': instantAt((item) => (item as { createdAt: string }).createdAt),
    // Addresses are unique, so the email sort has no tie to test.
    email: (item) => (item as { email: string }).email.toLowerCase(),
  },
  uniqueKeys: ['email'],
  setup: createOwnedTenant,
  teardown: removeOwnedTenant,
  seed: async (count) => {
    const now = Date.now()
    const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
    const rows = Array.from({ length: count }, (_unused, index) => ({
      tenant_id: owned.tenantId,
      email: `${tag}-i${pad(index)}@example.test`,
      role: SEEDED_ROLES[index % SEEDED_ROLES.length],
      token_hash: createHash('sha256')
        .update(`${tag}-i${pad(index)}`)
        .digest('hex'),
      invited_by: owned.ownerId,
      expires_at: expiresAt,
      created_at: joinedAtOf(now, index),
    }))
    await sql`insert into tenant_invitations ${sql(rows, 'tenant_id', 'email', 'role', 'token_hash', 'invited_by', 'expires_at', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from tenant_invitations where tenant_id = ${owned.tenantId}`
  },
  search: { text: `${tag}-i0002`, count: 1 },
  filters: [
    { query: { role: 'viewer' }, count: 2 },
    { query: { role: 'viewer,manager' }, count: 3 },
  ],
})

/**
 * The user whose own tenants the my-tenants block reads, and another user for the cursor replay.
 */
const member = { id: '', token: '', otherToken: '' }

describeListContract({
  name: 'GET /api/v1/tenants',
  app: () => app,
  path: () => '/api/v1/tenants',
  headers: () => ({ Authorization: `Bearer ${member.token}` }),
  isolate: () => ({}),
  // The rows depend on the calling user, who is not a query param.
  otherScope: {
    path: () => '/api/v1/tenants',
    headers: () => ({ Authorization: `Bearer ${member.otherToken}` }),
  },
  sorts: ['name', '-joined'],
  order: {
    name: (item) => (item as { tenant: { name: string } }).tenant.name.toLowerCase(),
    '-joined': instantAt((item) => (item as { joinedAt: string }).joinedAt),
  },
  setup: async () => {
    const user = await createTrackedUser()
    const other = await createTrackedUser()
    Object.assign(member, { id: user.id, token: tokenFor(user), otherToken: tokenFor(other) })
  },
  teardown: async () => {
    await truncateAuditLogs()
    await deleteTrackedUsers()
  },
  seed: async (count) => {
    const now = Date.now()
    const tenants = await sql<{ id: string }[]>`insert into tenants ${sql(
      Array.from({ length: count }, (_unused, index) => ({
        // Rows 0 and 1 share a name: a tie on the name sort.
        name: `${tag}-y${pad(index === 1 ? 0 : index)}`,
        slug: `${tag}-y${pad(index)}`,
      })),
      'name',
      'slug'
    )} returning id`
    const memberships = tenants.map((tenant, index) => ({
      user_id: member.id,
      tenant_id: tenant.id,
      role: index === 0 ? 'owner' : SEEDED_ROLES[index % SEEDED_ROLES.length],
      created_at: joinedAtOf(now, index),
    }))
    await sql`insert into user_memberships ${sql(memberships, 'user_id', 'tenant_id', 'role', 'created_at')}`
  },
  clear: async () => {
    await sql`delete from tenants where slug like ${like.myTenants}`
  },
  idOf: (item) => (item as { tenant: { id: string } }).tenant.id,
  search: { text: `${tag}-y0004`, count: 1 },
  filters: [
    { query: { role: 'owner' }, count: 1 },
    { query: { role: 'owner,viewer' }, count: 2 },
  ],
})
