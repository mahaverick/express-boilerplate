/**
 * @file The `email_link_tokens` CHECKs, asserted against the live per-worker
 * database with raw SQL inserts, so no application check stands in for the
 * database's. Every column but the one under test is valid, so each insert
 * fails on exactly the constraint it names.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { LINK_TOKEN_INTENTS } from '@/database/models/email-link-token.model'
import { sql } from '@/services/database.service'

const PREFIX = `link-model-${randomUUID()}-`
const PREFIX_LIKE = `${PREFIX}%`
const userIds: string[] = []
// eslint-disable-next-line unicorn/no-null -- a SQL NULL parameter: postgres.js refuses undefined
const SQL_NULL = null

afterEach(async () => {
  await sql`delete from email_link_tokens where email like ${PREFIX_LIKE}`
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
 * A valid token hash: the SHA-256 hex of fresh random bytes.
 */
function validHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

/**
 * The columns a raw insert sets; unset ones are a valid `sign_in` row's values.
 */
interface LinkRowSeed {
  intent?: string
  app?: string
  userId?: string | null
  sessionId?: string | null
  redirect?: string | null
  tokenHash?: string
}

/**
 * Inserts one `email_link_tokens` row with raw SQL.
 */
async function insertLinkRow(seed: LinkRowSeed): Promise<void> {
  const email = `${PREFIX}${randomUUID()}@example.test`
  await sql`
    insert into email_link_tokens (intent, app, email, user_id, session_id, redirect, token_hash, expires_at)
    values (
      ${seed.intent ?? 'sign_in'}, ${seed.app ?? 'web'}, ${email},
      ${seed.userId ?? SQL_NULL}, ${seed.sessionId ?? SQL_NULL}, ${seed.redirect ?? SQL_NULL},
      ${seed.tokenHash ?? validHash()}, now() + interval '15 minutes'
    )`
}

describe('email_link_tokens CHECKs', () => {
  it.each(LINK_TOKEN_INTENTS)('accepts a valid %s row', async (intent) => {
    const seed: LinkRowSeed =
      intent === 'sign_in'
        ? { redirect: '/tenants' }
        : { intent, app: 'apex', userId: await insertUser(), sessionId: randomUUID() }
    await insertLinkRow(seed)
    const rows = await sql`select 1 from email_link_tokens where email like ${PREFIX_LIKE}`
    expect(rows).toHaveLength(1)
  })

  it('refuses a sign_in row with a user_id', async () => {
    await expect(insertLinkRow({ userId: await insertUser() })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_link_tokens_shape_check',
    })
  })

  it('refuses a sign_in row with a session_id', async () => {
    await expect(insertLinkRow({ sessionId: randomUUID() })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_link_tokens_shape_check',
    })
  })

  it('refuses a step_up row without a session_id', async () => {
    await expect(
      insertLinkRow({ intent: 'step_up', app: 'apex', userId: await insertUser() })
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'email_link_tokens_shape_check' })
  })

  it('refuses a step_up row without a user_id', async () => {
    await expect(
      insertLinkRow({ intent: 'step_up', app: 'apex', sessionId: randomUUID() })
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'email_link_tokens_shape_check' })
  })

  it('refuses a step_up row with a redirect', async () => {
    await expect(
      insertLinkRow({
        intent: 'step_up',
        app: 'apex',
        userId: await insertUser(),
        sessionId: randomUUID(),
        redirect: '/tenants',
      })
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'email_link_tokens_shape_check' })
  })

  it('refuses an intent outside the list', async () => {
    await expect(insertLinkRow({ intent: 'refresh' })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_link_tokens_intent_check',
    })
  })

  it('refuses an app outside web and apex', async () => {
    await expect(insertLinkRow({ app: 'mobile' })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_link_tokens_app_check',
    })
  })

  it('refuses a token_hash that is not 64 lowercase hex', async () => {
    for (const tokenHash of [validHash().toUpperCase(), validHash().slice(1), 'z'.repeat(64)]) {
      await expect(insertLinkRow({ tokenHash })).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'email_link_tokens_token_hash_check',
      })
    }
  })
})
