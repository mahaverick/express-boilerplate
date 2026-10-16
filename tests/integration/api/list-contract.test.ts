/**
 * @file The shared list contract (tests/helpers/list-contract.ts) over every
 * database-backed list endpoint. Each block isolates its rows with a
 * per-file tag or a fresh tenant or user, so other files' rows in this
 * worker's database never change a count.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { describeListContract } from '../../helpers/list-contract'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
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
