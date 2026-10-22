/**
 * @file What migrations 0028, 0029 and 0030 leave on `user_tokens` for emailed links,
 * asserted with raw SQL inserts so no application check stands in for the
 * database's: `user_tokens_shape_check` per purpose, `user_tokens_app_check`
 * and `user_tokens_purpose_check`. Every column but the one under
 * test is valid, so each insert fails on exactly the constraint it names.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { LINK_TOKEN_INTENTS, LINK_TOKEN_PURPOSES } from '@/database/models/user-token.model'
import { sql } from '@/services/database.service'

const PREFIX = `link-schema-${randomUUID()}-`
const PREFIX_LIKE = `${PREFIX}%`
const userIds: string[] = []
const tenantIds: string[] = []
const SQL_NULL = null

afterEach(async () => {
  await sql`delete from user_tokens where email like ${PREFIX_LIKE}`
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * Inserts a user with raw SQL, tracked for cleanup, and returns its id.
 */
async function insertUser(): Promise<string> {
  const id = randomUUID()
  const email = `${PREFIX}${id}@example.test`
  await sql`insert into users (id, email) values (${id}, ${email})`
  userIds.push(id)
  return id
}

/**
 * The columns a raw insert sets; each defaults to SQL NULL except
 * `purpose` (`sign_in_link`), `email` (a fresh address) and `app` (`web`).
 * Pass `null` to clear one of those three.
 */
interface TokenRowSeed {
  purpose?: string
  userId?: string | null
  sessionId?: string | null
  email?: string | null
  app?: string | null
  redirect?: string | null
  invitationId?: string | null
}

/**
 * Inserts one `user_tokens` row with raw SQL.
 */
async function insertTokenRow(seed: TokenRowSeed): Promise<void> {
  const email = seed.email === undefined ? `${PREFIX}${randomUUID()}@example.test` : seed.email
  const app = seed.app === undefined ? 'web' : seed.app
  await sql`
    insert into user_tokens (purpose, user_id, session_id, email, app, redirect, invitation_id, token_hash, expires_at)
    values (
      ${seed.purpose ?? 'sign_in_link'}, ${seed.userId ?? SQL_NULL}, ${seed.sessionId ?? SQL_NULL},
      ${email}, ${app}, ${seed.redirect ?? SQL_NULL}, ${seed.invitationId ?? SQL_NULL},
      ${randomBytes(32).toString('hex')}, now() + interval '15 minutes'
    )`
}

/**
 * A valid `step_up_link` seed for a fresh user, with `overrides` merged over it.
 */
async function stepUpSeed(overrides: TokenRowSeed = {}): Promise<TokenRowSeed> {
  return {
    purpose: 'step_up_link',
    userId: await insertUser(),
    sessionId: randomUUID(),
    app: 'apex',
    ...overrides,
  }
}

/**
 * Inserts a tenant and a pending invitation in it with raw SQL, tracked for
 * cleanup (the invitation goes with its tenant), and returns the invitation's id.
 */
async function insertInvitation(): Promise<string> {
  const inviterId = await insertUser()
  const tenantId = randomUUID()
  const invitationId = randomUUID()
  const slug = `${PREFIX}${tenantId}`
  await sql`insert into tenants (id, name, slug) values (${tenantId}, 'Acme Inc', ${slug})`
  tenantIds.push(tenantId)
  await sql`
    insert into tenant_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${invitationId}, ${tenantId}, ${`${PREFIX}${invitationId}@example.test`}, 'editor',
      ${randomBytes(32).toString('hex')}, ${inviterId}, now() + interval '3 days')`
  return invitationId
}

/**
 * A valid `invitation_link` seed for a fresh invitation, with `overrides` merged over it.
 */
async function invitationSeed(overrides: TokenRowSeed = {}): Promise<TokenRowSeed> {
  return { purpose: 'invitation_link', invitationId: await insertInvitation(), ...overrides }
}

/**
 * A valid seed for one link intent.
 */
async function seedFor(intent: (typeof LINK_TOKEN_INTENTS)[number]): Promise<TokenRowSeed> {
  if (intent === 'sign_in') return { redirect: '/tenants' }
  return intent === 'step_up' ? stepUpSeed() : invitationSeed()
}

const SHAPE = { code: '23514', constraint_name: 'user_tokens_shape_check' }

describe('user_tokens link CHECKs', () => {
  it.each(LINK_TOKEN_INTENTS)('accepts a valid row for a %s link', async (intent) => {
    const purpose = LINK_TOKEN_PURPOSES[intent]
    await insertTokenRow(await seedFor(intent))
    const rows = await sql`select purpose from user_tokens where email like ${PREFIX_LIKE}`
    expect(rows).toEqual([{ purpose }])
  })

  it('refuses a sign_in_link row with a user_id', async () => {
    await expect(insertTokenRow({ userId: await insertUser() })).rejects.toMatchObject(SHAPE)
  })

  it('refuses a sign_in_link row with a session_id', async () => {
    await expect(insertTokenRow({ sessionId: randomUUID() })).rejects.toMatchObject(SHAPE)
  })

  it('refuses a sign_in_link row without an address or an app', async () => {
    await expect(insertTokenRow({ email: SQL_NULL })).rejects.toMatchObject(SHAPE)
    await expect(insertTokenRow({ app: SQL_NULL })).rejects.toMatchObject(SHAPE)
  })

  it('refuses a step_up_link row without a session_id or a user_id', async () => {
    await expect(insertTokenRow(await stepUpSeed({ sessionId: SQL_NULL }))).rejects.toMatchObject(
      SHAPE
    )
    await expect(insertTokenRow(await stepUpSeed({ userId: SQL_NULL }))).rejects.toMatchObject(
      SHAPE
    )
  })

  it('refuses a step_up_link row with a redirect', async () => {
    await expect(insertTokenRow(await stepUpSeed({ redirect: '/tenants' }))).rejects.toMatchObject(
      SHAPE
    )
  })

  it('refuses a refresh row that carries an address', async () => {
    await expect(
      insertTokenRow({
        purpose: 'refresh',
        userId: await insertUser(),
        sessionId: randomUUID(),
        app: SQL_NULL,
      })
    ).rejects.toMatchObject(SHAPE)
  })

  it('refuses a refresh row with no user', async () => {
    await expect(
      insertTokenRow({
        purpose: 'refresh',
        sessionId: randomUUID(),
        email: SQL_NULL,
        app: SQL_NULL,
      })
    ).rejects.toMatchObject(SHAPE)
  })

  it('refuses an invitation_link row with a user_id, a session_id, a redirect or no invitation_id', async () => {
    const seeds = [
      await invitationSeed({ userId: await insertUser() }),
      await invitationSeed({ sessionId: randomUUID() }),
      await invitationSeed({ redirect: '/tenants' }),
      await invitationSeed({ invitationId: SQL_NULL }),
    ]
    for (const seed of seeds) {
      await expect(insertTokenRow(seed)).rejects.toMatchObject(SHAPE)
    }
  })

  it('refuses an invitation_id on every other purpose', async () => {
    const invitationId = await insertInvitation()
    await expect(insertTokenRow({ invitationId })).rejects.toMatchObject(SHAPE)
    await expect(insertTokenRow(await stepUpSeed({ invitationId }))).rejects.toMatchObject(SHAPE)
    await expect(
      insertTokenRow({
        purpose: 'refresh',
        userId: await insertUser(),
        sessionId: randomUUID(),
        email: SQL_NULL,
        app: SQL_NULL,
        invitationId,
      })
    ).rejects.toMatchObject(SHAPE)
  })

  it('refuses an app outside web and apex', async () => {
    await expect(insertTokenRow({ app: 'mobile' })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'user_tokens_app_check',
    })
  })

  it('refuses a purpose outside the list', async () => {
    await expect(insertTokenRow({ purpose: 'magic_link' })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'user_tokens_purpose_check',
    })
  })
})
